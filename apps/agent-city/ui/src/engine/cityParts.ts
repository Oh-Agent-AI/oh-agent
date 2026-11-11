/**
 * 城市部件：把 CityModel + CityLayout 变成 Three.js 场景（全部 InstancedMesh）。
 *
 * 一次模型刷新 = 一次 buffer 重建（毫秒级）；每帧只做增量：
 *  · 施工动画：只有显示进度在变的楼才重写矩阵（脏集驱动）。
 *  · 生命感：车 / 船 / 云 / 吊车 / 信标脉冲，均为常数成本的小矩阵更新。
 *  · 水面：自写轻量 shader（解析法线 + 菲涅尔 + 伪高光），不做反射/折射。
 */

import * as THREE from "three";
import { builtFractionAt, hashSeed, RENDER_CAP, type CityBuilding, type CityModel } from "../cityModel";
import { promenadeSegments, validRuns } from "./citySeaside";
import { HOTEL_CROWN_MAX_FINS, hotelCrownPlan, type CrownPiece } from "./cityHotelCrown";
import { roadsideSignPlan, rooftopSignPlan, type RooftopSignPlan } from "./citySkylineProps";
import { buildVillaComplex } from "./cityLandmarkVilla";
import type { CityLayout, DistrictLayout, Parcel, Vec2 } from "./cityLayout";
import { activeTheme, skyYawOf, type CityTheme } from "./cityTheme";
import type { CityAssets } from "./cityAssets";
import type { LoadedFlora } from "./cityFlora";
import { decorKindForName } from "./cityDecor";
import { makeDecoFacadeTexture, makeFacadeTexture, makeLabelSprite, paletteFor } from "./cityTextures";
import type { TerrainField } from "./cityLayout";
import { createRenderCanvas } from "./renderCanvas";
import { SegmentIndex, polygonDistance } from "./cityPlan";
import { buildAirport } from "./cityAirport";
import { LANDMARK_BUILDERS } from "./render/landmarkBuilders";
import { captureRenderedSolids, type RenderedSolidRoot, type RenderedSolidRole } from "./surface/renderedSolids";
import { holdMechaGlbUpgrade } from "../render/mecha/models";
import type { LandmarkHost } from "./models/landmarkContext";
import { buildGardens, buildCivics, buildFlags, buildPublicSites, updateCivics, writeCivic, type CivicSystemHost } from "./systems/civicSystem";
import { applyDistrictLandmarkGrowth, buildDistrictLandmarks, buildLandmarks, type LandmarkSystemHost } from "./systems/landmarkSystem";
import { battleClarityPresentation } from "./battleClarity";
import { LIGHT_BUDGET, activeBoost, lampTier, nightFactor, useOfZone, windowRate } from "./cityLightBudget";
import { roadPaintPlan } from "./cityRoadPaint";
import { buildGroundSpill, buildSeaMountains, buildTerrain, buildWater, type TerrainHost } from "./systems/terrainSystem";
import { applyFlora, buildTrees, type NatureHost } from "./systems/natureSystem";
import { applyCarDensity, buildBoats, buildCars, buildClouds, placeCar, type AmbientHost } from "./systems/ambientSystem";
import { buildRoadSurface, type RoadSurfaceHost } from "./systems/roadSurfaceSystem";
import { compileGroundRoadSurface, type CompiledGroundRoadSurface } from "./surface/groundRoadCompiler";
import type { CitySurfaceSource } from "./surface/citySurfacePort";
import type { RenderedSolidSource } from "./surface/renderedSolidTypes";
import type { SolidInput } from "../game/driving/CollisionIndex";
import { collectSceneSolids } from "./surface/sceneSolids";
import { buildInfrastructure, buildCulDeSacBulbs, buildJunctionIslands, buildChannelizedJunctions, buildDistrictExpressways, buildHighwayRamps, buildTrussBridges, type RoadHost } from "./systems/roadSystem";
import { urbanPromenadeSegments, buildPromenade, buildBeachFurniture, buildBeachRibbon, buildMarina, buildLifeguardTowers, type SeasideHost } from "./systems/seasideSystem";
import { applySelfLit, applyNightOverlay, buildNightLights, setNightGlow, setNightHour, setNightWater, setSkyMix, type NightHost } from "./render/nightLighting";
import { clearCarStreetLamps, updateCarStreetLamps } from "./render/drivingStreetLights";
import { anchorFor, anchors, buildLabels, decorAt, decorTargets, hideOverlaysForPhoto, idAt, makeGroundRing, setHovered, setLabelsVisible, setSelected, type UiOverlayHost } from "./systems/uiOverlays";

export type CityStaticSceneSource = Readonly<{ layout: CityLayout; rendered: RenderedSolidSource; solids: readonly SolidInput[];
  isCurrent: () => boolean; verifyCurrent: () => boolean }>;

import { artDecoTowerGeometry, BOX, CYLINDER, EXPRESSWAY_DECK_THICKNESS, EXPRESSWAY_DECK_WIDTH, baseSpeedOf, expresswayDeckHeights, mergeGeometries, originOf, samplePolyline, selfLitMaterial } from "./render/shared";
import type { BuildingRuntime, Car, CarPath, NightLights, QualityLevel } from "./render/types";
export type { QualityLevel };
import { FACADE_GRIDS, facadeMaterial, type FacadeUniforms } from "./render/facadeMaterial";
import { appendRuntimes, applyConstruction, applyCraneArm, buildAnomalyMarkers, buildHeroCrown, buildMassing, buildRoadsideSigns, buildRuntimes, buildUrbanContext, facadeFor, hideAll, occupantsCanAppend, percentileOf, placeHeroCrown, roofKindFor, updateContext, writeContext, type BuildingSystemHost } from "./systems/buildingSystem";
export { occupantsCanAppend };
import { createClaimRuntime, createEditRuntime, createKitRuntime, disposeClaimRuntime, disposeEditRuntime, disposeKitRuntime, replayKitRuntime, stepEditRuntime, stepKitRuntime, type ClaimRuntime, type EditRuntime, type KitRuntime } from "./sessionKitOverride";
import type { ClaimTint } from "./squadEvents";
import type { OverlayDecision } from "./sessionKitConstruction";
import { editPresentation, type EditVisual } from "./sessionKitEditState";

export type OccupancySnapshot = {
  runtimeCount: number;
  shaftUuids: string[];
  byId: Record<string, { shaftPrimary: number; shaftUpper: number; podium: number; roof: number; x: number; z: number; facade: number }>;
};

/** 静态城（只依赖 seed 的部分：地形/基建/高架/公共设施/地标/远山/树/水面/
 *  车/船/云/花园）。模块级缓存——数据刷新重建时整段复用，重建成本只剩建筑层；
 *  只保留最近一个 seed（换岛时旧静态城整体释放）。 */

type StaticCity = {
  seed: number;
  themeId: string;
  landmarkWindows: CityParts["landmarkWindows"];
  lifeguardGlowMaterial: THREE.MeshBasicMaterial | null;
  layout: CityLayout;
  /** The ground road compilation the rendered road mesh was built from (driving reads the same one). */
  groundRoadSurface: CompiledGroundRoadSurface;
  drivingRoots: RenderedSolidRoot[];
  group: THREE.Group;
  disposables: Array<{ dispose: () => void }>;
  water: THREE.Mesh | null;
  treeMesh: THREE.InstancedMesh;
  carMesh: THREE.InstancedMesh;
  cars: Array<{ path: CarPath; distance: number; speed: number }>;
  boatMesh: THREE.InstancedMesh;
  boats: Array<{ path: CarPath; distance: number; speed: number; phase: number; wakeTimer: number }>;
  wakeMesh: THREE.InstancedMesh;
  wakes: Array<{ x: number; z: number; birth: number; driftX: number; driftZ: number }>;
  cloudMesh: THREE.InstancedMesh;
  clouds: Array<{ x: number; z: number; y: number; speed: number; scale: number }>;
  /** 缓存命中时新实例上这些字段是空的（它们在静态构建里赋值）：地面素材/水面倒影与夜间开关/摩天轮旋转/夜间灯光都要随缓存带回。 */
  terrainUniforms: Record<string, { value: unknown }> | null;
  /** 旗帜摆动的时间 uniform：材质经缓存共享，uniform 对象也必须随缓存带回。 */
  flagTime: { value: number } | null;
  waterAssetUniforms: Record<string, { value: unknown }> | null;
  landmarkSpinners: Array<{ object: THREE.Object3D; axis: "x" | "y" | "z"; speed: number }>;
  nightLights: NightLights | null;
  context: { bodies: THREE.InstancedMesh; crowns: THREE.InstancedMesh; matrices: Float32Array } | null;
  /** 配套网格随静态城复用，拾取索引与落成进度也必须带回：曾漏带，缓存命中后点医院/学校只剩通用「城市配套」，
   * 没有「打开设施数据」，回放时配套也不再按进度长出。进度数组与网格矩阵同一份状态，共享引用而非拷贝。 */
  civics: { pieces: CityParts["civicPieces"]; meshes: THREE.InstancedMesh[]; progress: number[]; target: number[] };
};
let staticCityCache: StaticCity | null = null;

export class CityParts {
  static constructCount = 0;
  static appendCount = 0;
  static resetMountCounters(): void { CityParts.constructCount = 0; CityParts.appendCount = 0; }

  private drivingRoots: RenderedSolidRoot[] = [];
  private drivingFreezeCount = 0;
  private drivingFrozenSource: CitySurfaceSource | null = null;
  private staticFrozenSource: CityStaticSceneSource | null = null;
  private drivingDisposed = false;
  private drivingModelHolds: Array<() => void> = [];
  private drivingDeferredCursor: [number, boolean, number] | null = null;
  private drivingDeferredSnap: boolean | null = null;
  private drivingDeferredReset = false;
  readonly group = new THREE.Group();
  readonly raycastTargets: THREE.Object3D[] = [];
  readonly water: THREE.Mesh | null;
  private readonly runtimes: BuildingRuntime[] = [];
  private readonly runtimeById = new Map<string, BuildingRuntime>();
  private readonly kitBySession = new Map<string, KitRuntime>();
  private readonly editBySession = new Map<string, EditRuntime>();
  private readonly claimBySession = new Map<string, ClaimRuntime>();
  private readonly shaftMeshes: THREE.InstancedMesh[] = [];
  private zoneById: Map<string, string> = new Map();
  private readonly shaftIdByInstance: Array<Map<number, string>> = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly podiumMesh: THREE.InstancedMesh;
  private readonly roofMesh: THREE.InstancedMesh;
  private readonly facadeUniforms: FacadeUniforms[] = [];
  /** 海滨装饰艺术低层楼的附件：圆角转角柱、顶部阶梯女儿墙、底层遮阳棚（每栋 3 个实例）。 */
  private readonly decoTrimMesh: THREE.InstancedMesh;
  /** 屋顶轮廓网格（下标 = runtime.roof；不是这种轮廓的实例缩成 0）。 */
  private readonly roofProfiles: THREE.InstancedMesh[] = [];
  private readonly gardenTreeMesh: THREE.InstancedMesh;
  /** 城市配套（学校/商场/医院）：每个部件记住所属配套与「满高」矩阵参数，按落成进度纵向长出来。 */
  private civicPieces: Array<{ civic: number; mesh: 0 | 1 | 2; index: number; x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw: number; baseY: number }> = [];
  private civicMeshes: THREE.InstancedMesh[] = [];
  private civicProgress: number[] = [];
  private civicTarget: number[] = [];
  private heroParts: { spire: THREE.Mesh; rings: THREE.Mesh[]; beam: THREE.Mesh | null } | null = null;
  private readonly decoCornerMesh: THREE.InstancedMesh;
  private nightLights: NightLights | null = null;
  private terrainUniforms: Record<string, { value: unknown }> | null = null;
  private spillTexture: THREE.Texture | null = null;
  private nightHour = 21;
  private flagTime: { value: number } | null = null;
  private waterAssetUniforms: Record<string, { value: unknown }> | null = null;
  /** 屋顶霓虹描边：比屋顶略大的自发光薄板，露出的一圈即霓虹；仅日落主题。 */
  private readonly neonMesh: THREE.InstancedMesh;
  private readonly scaffoldMesh: THREE.InstancedMesh;
  private readonly antennaMesh: THREE.InstancedMesh;
  private readonly cylinderMesh: THREE.InstancedMesh;
  private readonly beaconMesh: THREE.InstancedMesh;
  private readonly craneMastMesh: THREE.InstancedMesh;
  private readonly craneArmMesh: THREE.InstancedMesh;
  /** 海滨酒店冠（L-1）：鳍片箱心锚定（cityHotelCrown 的 y 语义），冠底霓虹带实例色跨 bloom 阈值。 */
  private readonly crownFinMesh: THREE.InstancedMesh;
  private readonly crownStripMesh: THREE.InstancedMesh;
  /** 屋顶立牌/路边广告牌（L-2）：柱/板哑光件，框/条是实例色霓虹载体；牌位上限 24 屋顶 + 8 路边。 */
  private readonly signPostMesh: THREE.InstancedMesh;
  private readonly signPanelMesh: THREE.InstancedMesh;
  private readonly signFrameMesh: THREE.InstancedMesh;
  private readonly signStripeMesh: THREE.InstancedMesh;
  /** 已编址的牌位总数（屋顶 + 路边）；四批次的 count 按它 ×件数 收口。 */
  private signPostCount = 0;
  private readonly treeMesh: THREE.InstancedMesh;
  /** 生态带植被网格（加载完成后替换程序化树；每个树种一个）。 */
  private floraMeshes: THREE.InstancedMesh[] = [];
  /** 地标里会动的部件：摩天轮转盘、灯塔光束。 */
  private landmarkSpinners: Array<{ object: THREE.Object3D; axis: "x" | "y" | "z"; speed: number }> = [];
  private readonly carMesh: THREE.InstancedMesh;
  private carKeep = 1;
  private readonly boatMesh: THREE.InstancedMesh;
  private readonly wakeMesh: THREE.InstancedMesh;
  private readonly wakes: Array<{ x: number; z: number; birth: number; driftX: number; driftZ: number }>;
  private readonly cloudMesh: THREE.InstancedMesh;
  private readonly anomalyMarkers: Array<{ mesh: THREE.Mesh; ring: THREE.Mesh; baseY: number; phase: number }> = [];
  private readonly labels: THREE.Sprite[] = [];
  private readonly hoverRing: THREE.Mesh;
  private readonly selectRing: THREE.Mesh;
  private readonly cars: Car[];
  private readonly boats: Array<{ path: CarPath; distance: number; speed: number; phase: number; wakeTimer: number }>;
  private readonly clouds: Array<{ x: number; z: number; y: number; speed: number; scale: number }>;
  private readonly waterUniforms: { uTime: { value: number }; uSun: { value: THREE.Vector3 }; uShallow: { value: THREE.Color }; uDeep: { value: THREE.Color }; uSky: { value: THREE.Color } } | null;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scaleVector = new THREE.Vector3();
  private readonly positionVector = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly spillWhite = new THREE.Color();
  private readonly hsl = { h: 0, s: 0, l: 0 };
  private cursor = Number.NaN;
  private live = true;
  private labelsVisible = true;
  private battleClarity = false;
  /** 重建前各楼的显示进度（null = 首个模型，全城直接成像）。 */
  private previousDisplays: Map<string, number> | null = null;
  hoveredId: string | null = null;
  selectedId: string | null = null;

  constructor(private model: CityModel, private layout: CityLayout, previousDisplays: Map<string, number> | null = null,
    private readonly theme: CityTheme = activeTheme()) {
    CityParts.constructCount += 1;
    this.previousDisplays = previousDisplays;
    const total = model.buildings.length;
    // 分页追加预留到规划人口：InstancedMesh 的 max 在构造时钉死，先按全窗会话数开槽，
    // 后面的页只提高 count / 必要时 grow，不必拆掉整层建筑网格。
    const planned = Math.min(RENDER_CAP, Math.max(total, Number.isFinite(model.stats?.totalSessions) ? model.stats.totalSessions : 0));

    // ── 静态城（seed 决定）：缓存命中则整段复用，重建只花在建筑层 ──────
    let staticCity = staticCityCache && staticCityCache.seed === layout.seed && staticCityCache.themeId === theme.name && staticCityCache.layout.scaleTier === layout.scaleTier
      && staticCityCache.layout.worldProfileKey === layout.worldProfileKey
      && staticCityCache.layout.coastalConfigKey === layout.coastalConfigKey
      && staticCityCache.layout.activityKey === layout.activityKey // G1：建成区变化 → 地面与路网重画
      && staticCityCache.layout.highways === layout.highways
      && JSON.stringify([staticCityCache.layout.civics, staticCityCache.layout.gardens, staticCityCache.layout.contextBuildings]) === JSON.stringify([layout.civics, layout.gardens, layout.contextBuildings]) ? staticCityCache : null;
    if (!staticCity) {
      staticCityCache?.disposables.forEach((disposable) => disposable.dispose());
      const staticBucket: Array<{ dispose: () => void }> = [];
      (this.disposables as Array<{ dispose: () => void }>) = staticBucket;
      this.buildTerrain();
      this.buildRoadSurface();
      this.buildInfrastructure();
      this.buildCulDeSacBulbs();
      buildJunctionIslands(this as unknown as RoadHost);
      this.buildChannelizedJunctions();
      this.buildDistrictExpressways();
      buildHighwayRamps(this as unknown as RoadHost);
      this.nightLights = this.buildNightLights();
      this.buildPublicSites();
      const hasOcean = this.layout.features?.ocean !== false;
      if (hasOcean) this.buildMarina();
      {
        // L-4 机场岛：布局期规划（layout.airport），堤道已是路网里的一段桥面（上面的桥梁渲染画它）。
        // 岛是可行驶的地标平台：航站楼 / 塔台 / 指廊进驾驶碰撞（注册为地标驾驶根），跑道等贴面薄层自标非实体。
        const airport = this.layout.airport;
        if (airport) this.registerDrivingRoots("landmark", () => this.group.add(buildAirport(airport, this.disposables, this.nightLights?.heads ?? null,
          // 机坪上那架飞机与飞行游戏同一尺度（GameSession：flightParamsFor(城区对角线)）。
          Math.hypot(this.layout.urbanBounds.right - this.layout.urbanBounds.left, this.layout.urbanBounds.south - this.layout.urbanBounds.north))));
      }
      this.registerDrivingRoots("civic", () => this.buildCivics());
      this.registerDrivingRoots("landmark", () => this.buildLandmarks());
      this.buildTrussBridges();
      this.registerDrivingRoots("landmark", () => this.buildDistrictLandmarks());
      this.registerDrivingRoots("context", () => this.buildUrbanContext());
      if (hasOcean) {
        this.buildSeaMountains();
        this.buildBeachRibbon();
      }
      const seaside = this.layout.seaside;
      if (hasOcean && seaside && !seaside.degraded) this.buildPromenade(promenadeSegments(seaside));
      this.buildPromenade(this.urbanPromenadeSegments());
      // 装饰酒店排已退役：酒店地块交给会话（cityLayout hotelBlocks），只有落户的会话才成楼。
      if (hasOcean) {
        this.buildLifeguardTowers();
        this.buildBeachFurniture();
      }
      // 酒店招牌随装饰酒店一起退役（它们挂在不存在的楼面上）。
      this.treeMesh = this.buildTrees();
      const carResult = this.buildCars();
      this.carMesh = carResult.mesh;
      const boatResult = this.buildBoats();
      this.boatMesh = boatResult.mesh;
      this.wakeMesh = boatResult.wakeMesh;
      this.wakes = boatResult.wakes;
      const cloudResult = this.buildClouds();
      this.cloudMesh = cloudResult.mesh;
      this.water = hasOcean ? this.buildWater() : null;
      this.buildGardens();
      this.buildFlags();
      staticCity = {
        seed: layout.seed,
        themeId: theme.name,
        layout,
        groundRoadSurface: this.groundRoadSurface!,
        drivingRoots: this.drivingRoots.slice(),
        group: this.group,
        disposables: staticBucket,
        water: this.water,
        treeMesh: this.treeMesh,
        carMesh: this.carMesh,
        cars: carResult.cars,
        boatMesh: this.boatMesh,
        boats: boatResult.boats,
        wakeMesh: this.wakeMesh,
        wakes: boatResult.wakes,
        cloudMesh: this.cloudMesh,
        clouds: cloudResult.clouds,
        terrainUniforms: this.terrainUniforms,
        flagTime: this.flagTime,
        waterAssetUniforms: this.waterAssetUniforms,
        landmarkSpinners: this.landmarkSpinners,
        nightLights: this.nightLights,
        context: this.context,
        landmarkWindows: this.landmarkWindows,
        lifeguardGlowMaterial: this.lifeguardGlowMaterial,
        civics: { pieces: this.civicPieces, meshes: this.civicMeshes, progress: this.civicProgress, target: this.civicTarget },
      };
      staticCityCache = staticCity;
      // this.group 曾是静态组：让位给动态组，静态组挂为其子节点。
      (this.group as THREE.Group) = new THREE.Group();
      (this.disposables as Array<{ dispose: () => void }>) = [];
    }
    this.group.add(staticCity.group);
    this.drivingRoots = staticCity.drivingRoots.slice();
    // The legacy surface-only port carries the compiled road/structure geometry.
    // Scene proxies belong to captureDrivingWorld(), where they are sampled under
    // the explicit display-freeze lease below.
    this.staticSource = Object.freeze({ layout: staticCity.layout, ground: staticCity.groundRoadSurface });
    this.water = staticCity.water;
    this.treeMesh = staticCity.treeMesh;
    this.carMesh = staticCity.carMesh;
    this.boatMesh = staticCity.boatMesh;
    this.cloudMesh = staticCity.cloudMesh;
    this.cars = staticCity.cars;
    this.boats = staticCity.boats;
    this.clouds = staticCity.clouds;
    this.wakeMesh = staticCity.wakeMesh;
    this.wakes = staticCity.wakes;
    this.terrainUniforms = staticCity.terrainUniforms;
    this.flagTime = staticCity.flagTime;
    this.waterAssetUniforms = staticCity.waterAssetUniforms;
    this.landmarkSpinners = staticCity.landmarkSpinners;
    this.nightLights = staticCity.nightLights;
    this.context = staticCity.context;
    // 夜间材质随静态城一起复用：曾只缓存网格不缓存这两个引用，缓存命中后救生塔灯与地标亮窗夜里不再亮。
    this.landmarkWindows = staticCity.landmarkWindows;
    this.lifeguardGlowMaterial = staticCity.lifeguardGlowMaterial;
    this.civicPieces = staticCity.civics.pieces;
    this.civicMeshes = staticCity.civics.meshes;
    this.civicProgress = staticCity.civics.progress;
    this.civicTarget = staticCity.civics.target;
    this.captureAnimationOrigin();
    this.waterUniforms = this.water ? (this.water.material as THREE.ShaderMaterial).uniforms as unknown as {
      uTime: { value: number };
      uSun: { value: THREE.Vector3 };
      uShallow: { value: THREE.Color };
      uDeep: { value: THREE.Color };
      uSky: { value: THREE.Color };
    } : null;

    // ── 建筑：立面（3 变体 × [主体+退台] 两段）──────────────────────────
    const facades = [makeFacadeTexture(0, 11), makeFacadeTexture(1, 37), makeFacadeTexture(2, 71), makeDecoFacadeTexture()];
    facades.forEach((texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      this.disposables.push(texture);
    });
    // 立面由地块分区驱动：市中心玻璃幕墙 / 商业横带 / 居住窗洞。
    const zoneById = new Map<string, string>();
    for (const district of this.layout.districts) {
      for (const [id, parcel] of district.slots) zoneById.set(id, parcel.zone);
    }
    this.zoneById = zoneById;
    const facadeCounts = [0, 0, 0, 0];
    for (const building of model.buildings) {
      if (!zoneById.has(building.id)) continue;
      facadeCounts[this.facadeFor(building)] += this.formOf(building) === "tower" || this.formOf(building) === "landmark" ? 2 : 1;
    }
    facades.forEach((texture, variant) => {
      const capacity = Math.max(facadeCounts[variant] + 8, planned * 2 + 8);
      const geometry = BOX.clone();
      geometry.setAttribute("aFloors", new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1));
      geometry.setAttribute("aLight", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2)); // x = 办公用途(0/1)，y = 活跃会话(0/1)
      // 装饰艺术立面一块平铺画 2 层，其余程序化立面沿用一层一块。
      const uniforms: FacadeUniforms = {
        // 一块纹理覆盖几层楼：程序化立面画的是 4 层（makeFacadeTexture），装饰艺术画 2 层。
        // 曾按「每层一块」铺，每层楼塞进 4 排窗、窗高只有四分之一——窗又扁又小，玻璃反射只落在细缝里。
        uRows: { value: variant === 3 ? 2 : 4 },
        uPhoto: { value: 0 },
        uPhotoTex: { value: null },
        uPhotoRows: { value: 1 },
        uTileWidth: { value: 1 },
        uSelfLit: { value: 0.24 },
        uWindowGlow: { value: 0 },
        uRateRes: { value: 0.4 },
        uRateOff: { value: 0.4 },
        uGrid: { value: new THREE.Vector2(...(FACADE_GRIDS[variant] ?? [4, 4])) },
        uEnv: { value: null },
        uEnvStrength: { value: 0 },
        uGradeTop: { value: new THREE.Color(this.theme.skyGrade.top) },
        uGradeHorizon: { value: new THREE.Color(this.theme.skyGrade.horizon) },
        uGradeAmount: { value: this.theme.skyGrade.amount },
        uSkyYaw: { value: skyYawOf(this.theme) },
      };
      this.facadeUniforms.push(uniforms);
      const mesh = new THREE.InstancedMesh(geometry, facadeMaterial(texture, uniforms, String(variant)), capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = `city-shafts-${variant}`;
      this.shaftMeshes.push(mesh);
      this.shaftIdByInstance.push(new Map());
      this.group.add(mesh);
      this.raycastTargets.push(mesh);
      this.disposables.push(geometry, mesh.material);
    });

    // 屋顶轮廓：坡顶（三棱柱，屋脊沿 z）、尖顶（四棱锥）、退台冠（小一号的盒子）、屋顶花园（草皮板）。
    const pitched = BOX.clone();
    {
      const position = pitched.getAttribute("position") as THREE.BufferAttribute;
      for (let index = 0; index < position.count; index += 1) if (position.getY(index) > 0.99) position.setX(index, 0);
      pitched.computeVertexNormals();
    }
    const spire = new THREE.ConeGeometry(0.5, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0);
    const profileGeometries = [pitched, spire, BOX, BOX];
    profileGeometries.forEach((geometry, index) => {
      const mesh = this.makeInstanced(geometry, selfLitMaterial(0.18), planned);
      mesh.castShadow = true;
      mesh.name = `city-roof-profile-${index + 1}`;
      this.roofProfiles.push(mesh);
    });
    this.gardenTreeMesh = this.makeInstanced(new THREE.IcosahedronGeometry(1, 0).translate(0, 1, 0), new THREE.MeshLambertMaterial({ color: this.theme.foliage }), planned * 3);
    this.gardenTreeMesh.castShadow = true;
    const decoCount = Math.max(facadeCounts[3] + 4, planned);
    this.decoTrimMesh = this.makeInstanced(BOX, selfLitMaterial(0.24), decoCount * 2);
    this.decoCornerMesh = this.makeInstanced(CYLINDER, selfLitMaterial(0.24), decoCount);
    this.podiumMesh = this.makeInstanced(BOX, new THREE.MeshLambertMaterial({ color: "#e8e2d5" }), planned);
    this.roofMesh = this.makeInstanced(BOX, new THREE.MeshLambertMaterial({ color: "#ffffff" }), planned);
    this.neonMesh = this.makeInstanced(BOX, new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }), planned);
    this.neonMesh.castShadow = false;
    this.scaffoldMesh = this.makeInstanced(BOX, new THREE.MeshLambertMaterial({ color: "#e0a83f", transparent: true, opacity: 0.24, depthWrite: false }), planned);
    this.scaffoldMesh.castShadow = false;
    {
      // L-6 圆筒玻璃塔（backlog）：竖向条纹幕墙，夜里亮窗（landmarkWindows 同一套白天/夜间贴图切换）。
      const day = createRenderCanvas(); day.width = 64; day.height = 32; const dctx = day.getContext("2d");
      if (dctx) { dctx.fillStyle = "#6f9fb4"; dctx.fillRect(0, 0, 64, 32); dctx.fillStyle = "#e8eef2"; for (let x = 0; x < 64; x += 8) dctx.fillRect(x, 0, 1.5, 32); dctx.fillRect(0, 30, 64, 2); }
      const lit = createRenderCanvas(); lit.width = 64; lit.height = 32; const lctx = lit.getContext("2d");
      if (lctx) { lctx.fillStyle = "#000"; lctx.fillRect(0, 0, 64, 32); for (let x = 0; x < 64; x += 8) { const on = hashSeed(`cyl-window:${x}`); if (on < 0.3) continue; lctx.fillStyle = on > 0.8 ? "#bfe9ff" : "#ffd89a"; lctx.fillRect(x + 2, 4, 5, 22); } }
      const dayTex = new THREE.CanvasTexture(day as HTMLCanvasElement); const litTex = new THREE.CanvasTexture(lit as HTMLCanvasElement);
      for (const t of [dayTex, litTex]) { t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 10); }
      const glass = new THREE.MeshLambertMaterial({ color: "#ffffff", map: dayTex, emissive: new THREE.Color("#000000"), emissiveMap: dayTex });
      this.landmarkWindows.push({ material: glass, day: dayTex, lit: litTex, dayEmissive: new THREE.Color("#000000") });
      this.disposables.push(dayTex, litTex);
      this.cylinderMesh = this.makeInstanced(new THREE.CylinderGeometry(0.5, 0.5, 1, 20).translate(0, 0.5, 0), glass, 64);
      this.cylinderMesh.name = "city-shafts-cylinder";
    }
    this.antennaMesh = this.makeInstanced(new THREE.CylinderGeometry(0.09, 0.16, 1, 5).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: "#5d6470" }), 96);
    this.beaconMesh = this.makeInstanced(new THREE.SphereGeometry(0.32, 8, 6), new THREE.MeshBasicMaterial({ color: "#ffb02e" }), 96);
    this.craneMastMesh = this.makeInstanced(new THREE.BoxGeometry(0.85, 1, 0.85).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: "#ffb400", emissive: "#6b4300" }), 48);
    this.craneArmMesh = this.makeInstanced(new THREE.BoxGeometry(1, 0.32, 0.32), new THREE.MeshLambertMaterial({ color: "#ffb400", emissive: "#6b4300" }), 48);
    // 海滨酒店冠：容量按「已落户的酒店地块」预留（有会话落户才有楼，没落户的空地块不需要冠）。
    {
      const hotelSlots = new Set<string>();
      for (const district of this.layout.districts) for (const parcel of district.slots.values()) if (parcel.blockId.startsWith("hotel:")) hotelSlots.add(parcel.id);
      this.crownFinMesh = this.makeInstanced(new THREE.BoxGeometry(1, 1, 1), selfLitMaterial(0.18), Math.max(1, hotelSlots.size * HOTEL_CROWN_MAX_FINS));
      this.crownFinMesh.castShadow = true;
      this.crownStripMesh = this.makeInstanced(BOX, new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }), Math.max(1, hotelSlots.size));
      this.crownStripMesh.castShadow = false;
    }
    // 屋顶立牌/路边广告牌：牌位索引统一编址（屋顶 0..23，路边 24..31），四批次按 位×件数 取下标。
    this.signPostMesh = this.makeInstanced(BOX, new THREE.MeshLambertMaterial({ color: "#8a929c" }), 64);
    this.signPanelMesh = this.makeInstanced(BOX, new THREE.MeshLambertMaterial({ color: "#f6f2e8" }), 32);
    this.signFrameMesh = this.makeInstanced(BOX, new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }), 128);
    this.signStripeMesh = this.makeInstanced(BOX, new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }), 96);

    // ── 动态层：溢出楼群 / 信标 / 标签 / 选中环 / 建筑运行时 ────────────
    this.registerDrivingRoots("massing", () => this.buildMassing());
    this.buildAnomalyMarkers();
    this.hoverRing = this.makeGroundRing("#087f62");
    this.selectRing = this.makeGroundRing("#c96f4a");
    this.registerDrivingRoots("building", () => this.buildRuntimes());
    this.buildLabels();
    for (const object of [...this.shaftMeshes, ...this.roofProfiles, this.podiumMesh, this.roofMesh,
      this.decoTrimMesh, this.decoCornerMesh, this.cylinderMesh, this.antennaMesh, this.scaffoldMesh,
      this.craneMastMesh, this.craneArmMesh, this.crownFinMesh, this.signPostMesh, this.signPanelMesh]) {
      this.drivingRoots.push({ object, role: "building" });
    }
    // The hero light beam is a transparent lighting effect, not architectural geometry.
    this.drivingRoots = this.drivingRoots.filter((root) => root.object !== this.heroParts?.beam);
    const lightEffects = [this.nightLights?.neon, this.nightLights?.pools, this.nightLights?.strips,
      this.lifeguardGlowMaterial, this.signageNeonMaterial].filter(Boolean);
    for (const root of this.drivingRoots) root.object.traverse((object) => {
      if (object instanceof THREE.Mesh && lightEffects.includes(object.material as THREE.MeshBasicMaterial)) object.userData.cityDrivingNonSolid = true;
    });
  }

  private registerDrivingRoots(role: RenderedSolidRole, build: () => void): void {
    const before = new Set(this.group.children); build();
    for (const object of this.group.children) if (!before.has(object) && object.name !== "city-civic-glow") this.drivingRoots.push({ object, role });
  }

  private makeInstanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(capacity, 1));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.disposables.push(geometry, material);
    return mesh;
  }

  private makeGroundRing(color: string): THREE.Mesh { return makeGroundRing(this as unknown as UiOverlayHost, color); }

  private buildTerrain(): void { buildTerrain(this as unknown as TerrainHost); }

  /** 平面镜反射输入：texture=null 关闭（省电档，或相机在水面以下）。 */
  setMirror(texture: THREE.Texture | null, matrix: THREE.Matrix4 | null): void {
    if (!this.waterAssetUniforms) return;
    this.waterAssetUniforms.uMirror.value = texture;
    this.waterAssetUniforms.uHasMirror.value = texture ? 1 : 0;
    if (matrix) (this.waterAssetUniforms.uMirrorMatrix.value as THREE.Matrix4).copy(matrix);
  }

  private buildGroundSpill(): void { buildGroundSpill(this as unknown as TerrainHost); }

  /** 本地小时 → 住宅/办公亮灯率（cityLightBudget.windowRate），驱动立面窗光与地面/水面光斑的强度。 */
  setNightHour(hour: number): void { setNightHour(this as unknown as NightHost, hour); }

  private applyNightOverlay(): void { applyNightOverlay(this as unknown as NightHost); }

  setNightWater(night: number): void { setNightWater(this as unknown as NightHost, night); }

  /** 昼夜天空混合量（0 = 黄昏/夜，1 = 白天）：水面与玻璃反射的粉紫调色量随白天程度衰减。 */
  setSkyMix(dayMix: number): void { setSkyMix(this as unknown as NightHost, dayMix); }

  /** 素材到齐后原地换上：地面细节、照片立面、灰泥法线、水面法线与天空反射。 */
  applyAssets(assets: CityAssets): void {
    const theme = this.theme;
    const mean = (texture: THREE.Texture): THREE.Vector3 => {
      const image = texture.image as CanvasImageSource & { width: number; height: number };
      const canvas = createRenderCanvas();
      canvas.width = canvas.height = 8;
      const ctx = canvas.getContext("2d");
      if (!ctx) return new THREE.Vector3(0.5, 0.5, 0.5);
      ctx.drawImage(image, 0, 0, 8, 8);
      const data = ctx.getImageData(0, 0, 8, 8).data;
      const sum = [0, 0, 0];
      for (let index = 0; index < data.length; index += 4) for (let c = 0; c < 3; c += 1) sum[c] += data[index + c];
      // 着色器里采样得到的是线性值（sRGB 纹理自动解码），均值也换算成线性。
      const toLinear = (v: number) => Math.pow(v / 255 / 64, 2.2);
      return new THREE.Vector3(toLinear(sum[0]), toLinear(sum[1]), toLinear(sum[2]));
    };
    if (this.terrainUniforms) {
      const ground = assets.ground;
      const pairs: Array<[string, { color: THREE.Texture; normal: THREE.Texture }]> = [["Asphalt", ground.asphalt], ["Concrete", ground.concrete], ["Sand", ground.sand], ["Mud", ground.mud], ["Grass", ground.grass]];
      for (const [name, layer] of pairs) {
        this.terrainUniforms[`u${name}C`].value = layer.color;
        this.terrainUniforms[`u${name}N`].value = layer.normal;
        this.terrainUniforms[`u${name}Mean`].value = mean(layer.color);
      }
      this.terrainUniforms.uDetail.value = 1;
    }
    // 照片立面：每张图的「每块平铺对应多少层」不同（窗格行数），uRows 让一层楼≈一行窗。
    // 一块平铺覆盖的楼层数与宽度（世界单位，窗宽≈2.4）：让窗格大小在三种立面间一致。
    const rows = [8, 10, 10];
    const tileWidths = [30, 32, 32];
    assets.facades.forEach((texture, variant) => {
      const uniforms = this.facadeUniforms[variant];
      if (!uniforms) return;
      uniforms.uPhotoTex.value = texture;
      uniforms.uPhoto.value = 1;
      uniforms.uPhotoRows.value = rows[variant];
      uniforms.uTileWidth.value = tileWidths[variant];
    });
    // 玻璃反射强度按立面：市中心玻璃幕墙最强，商业楼窗户次之，住宅与海滨灰泥楼的窗只带一点。
    const envStrength = [0.3, 0.7, 0.9, 0.3];
    // 反射一律用白天照片：黄昏的粉紫由 uGradeAmount 叠加（见 setSkyMix），白天不染色——和天穹的混合保持一致。
    const sky = assets.sky.day;
    this.facadeUniforms.forEach((uniforms, variant) => {
      uniforms.uEnv.value = sky;
      uniforms.uEnvStrength.value = envStrength[variant] ?? 0;
    });
    const deco = this.shaftMeshes[3]?.material as THREE.MeshLambertMaterial | undefined;
    if (deco) {
      deco.normalMap = assets.stuccoNormal;
      deco.normalScale.set(0.6, 0.6);
      deco.needsUpdate = true;
    }
    if (this.waterAssetUniforms) {
      this.waterAssetUniforms.uNormal.value = assets.waterNormal;
      this.waterAssetUniforms.uSkyTex.value = assets.sky.day;
      this.waterAssetUniforms.uHasAssets.value = 1;
    }
  }

  /** Batched city furniture and waterfront infrastructure, not selectable data. */
  private buildInfrastructure(): void { buildInfrastructure(this as unknown as RoadHost); }
  /** Compiled once per static city; the renderer and the driving surface consume this same object. */
  private groundRoadSurface: CompiledGroundRoadSurface | null = null;
  private staticSource: CitySurfaceSource | null = null;
  private buildRoadSurface(): void {
    this.groundRoadSurface = compileGroundRoadSurface(this.layout);
    buildRoadSurface(this as unknown as RoadSurfaceHost);
  }
  /** Layout + ground compilation the CURRENTLY drawn static city was built from (the static cache
   *  may reuse an earlier layout object): the driving surface must match what is on screen. */
  drivingSurfaceSource(): CitySurfaceSource | null { return this.staticSource; }

  /** Road-neutral reference-counted freeze shared by static collision and road readers.
   * Time changes queue until the last reader releases; rebuild/dispose still invalidate. */
  acquireStaticSceneSource(): { source: CityStaticSceneSource; drivingSource: CitySurfaceSource; release: () => void } {
    if (this.drivingDisposed || !this.staticSource) throw new Error("driving-world-unavailable");
    this.drivingFreezeCount++;
    try {
      if (!this.drivingFrozenSource) {
        this.group.traverse((object) => {
          if (object.userData.cityDrivingStaticPose !== true) return;
          for (const actor of object.children) if (actor instanceof THREE.Group) this.drivingModelHolds.push(holdMechaGlbUpgrade(actor));
        });
        const rendered = captureRenderedSolids(this.drivingRoots);
        const sceneSolids = Object.freeze(collectSceneSolids(this.group));
        // Geometry and proxy transforms are captured once for this display lease.
        // CityParts.update() and cursor/snap/reset writers are frozen while held,
        // so frame checks need only test the lease identity instead of traversing
        // every mesh buffer and re-collecting every proxy on every tick.
        let drivingSource!: CitySurfaceSource;
        const current = () => !this.drivingDisposed && this.drivingFreezeCount > 0 && this.drivingFrozenSource === drivingSource;
        drivingSource = Object.freeze({ ...this.staticSource, solids: () => sceneSolids, solidsCurrent: current,
          verifySolidsCurrent: () => current() && JSON.stringify(collectSceneSolids(this.group)) === JSON.stringify(sceneSolids),
          rendered: Object.freeze({ solids: rendered.solids, isCurrent: current, verifyCurrent: () => current() && rendered.isCurrent() }) });
        this.drivingFrozenSource = drivingSource;
        this.staticFrozenSource = Object.freeze({ layout: drivingSource.layout, rendered: drivingSource.rendered!, solids: sceneSolids,
          isCurrent: current, verifyCurrent: () => current() && drivingSource.verifySolidsCurrent!() });
      }
    } catch (error) {
      this.drivingFreezeCount--;
      for (const release of this.drivingModelHolds.splice(0)) release();
      throw error;
    }
    let active = true;
    return { source: this.staticFrozenSource!, drivingSource: this.drivingFrozenSource!, release: () => {
      if (!active) return; active = false;
      if (--this.drivingFreezeCount !== 0) return;
      this.drivingFrozenSource = null;
      this.staticFrozenSource = null;
      for (const release of this.drivingModelHolds.splice(0)) release();
      if (this.drivingDisposed) return;
      const cursor = this.drivingDeferredCursor, snap = this.drivingDeferredSnap, reset = this.drivingDeferredReset;
      this.drivingDeferredCursor = null; this.drivingDeferredSnap = null; this.drivingDeferredReset = false;
      if (cursor) this.applyCursor(...cursor);
      if (snap !== null) this.snapToTargets(snap);
      if (reset) this.resetAnimation();
    } };
  }

  /** Compatibility view for the road surface port, backed by the same freeze. */
  acquireDrivingWorldSource(): { source: CitySurfaceSource; release: () => void } {
    const frozen = this.acquireStaticSceneSource();
    return { source: frozen.drivingSource, release: frozen.release };
  }

  /** 尽端回车圈（形态批 §5-3）：合法尽端（culDeSacEnds）的回车圆盘 + 路缘描边，
   *  纯渲染装饰、不改路网拓扑；见 systems/roadSystem.ts。 */
  private buildCulDeSacBulbs(): void { buildCulDeSacBulbs(this as unknown as RoadHost); }

  /** 渠化 T 路口（渲染级）：30–50° 边缘带三岔的喇叭口 + 分流岛，见 roadSystem.buildChannelizedJunctions。 */
  private buildChannelizedJunctions(): void { buildChannelizedJunctions(this as unknown as RoadHost); }

  /** 区界高架：与北环高架同视觉语言（桥面/车道线/护栏/桥墩），
   *  沿规划折线分段铺装 —— harness 城区之间可辨认的硬边界。 */
  private buildDistrictExpressways(): void { buildDistrictExpressways(this as unknown as RoadHost); }

  /** 公共用地的 3D 体量：此前市政广场/车站/体育场/观景塔/港口只有地面纹理里的一块色块
   *  （海岸边那块灰色长方形就是港口）。全部由方块与圆柱拼成，局部坐标按地块 yaw 旋转。 */
  private buildPublicSites(): void { buildPublicSites(this as unknown as CivicSystemHost); }

  /** 小区中心花园：草坪 + 湖（与海面同一套水面材质，能映倒影）+ 湖石驳岸 + 假山叠石 + 亭 + 环湖树。 */
  /** 旗帜（tinyskies FlagSystem 手法）：各区花园一杆 harness 色旗 + 观测塔一面大旗。
   *  布料摆动在顶点着色器里做——摆幅从旗杆（x=0）到自由端渐增，双频叠加更像风。 */
  private buildFlags(): void { buildFlags(this as unknown as CivicSystemHost); }

  private buildGardens(): void { buildGardens(this as unknown as CivicSystemHost); }

  /** 夜间照明（静态，随 seed 缓存）：沿主干道两侧交错的路灯（杆 + 自发光灯头 + 地面光斑）、高架灯带。
   *  曾只有每条主干道路段中点一盏不发光的灯，夜里道路是一片黑——现在街道有"灯线"，这是夜景像城市的关键。 */
  private buildNightLights(): NightLights { return buildNightLights(this as unknown as NightHost); }

  /** 致敬型地标（程序化几何，不复刻具体建筑）。城市身份地标有 70 单位最低天际线预算，
   *  不随会话数缩小；会话楼仍保留真实 token 高度，数据建筑与装饰地标语义分离。 */
  private buildLandmarks(): void { buildLandmarks(this as unknown as LandmarkSystemHost); }

  /** 学校 / 商场 / 医院：由方块与圆柱拼成，局部坐标按街区朝向旋转。纯装饰，不进拾取。 */
  private buildCivics(): void { buildCivics(this as unknown as CivicSystemHost); }

  /** 按进度写一座配套的部件矩阵：从地面纵向长出来（y 方向缩放），进度 0 时整座藏起。 */
  private writeCivic(civicIndex: number): void { writeCivic(this as unknown as CivicSystemHost, civicIndex); }

  private updateCivics(dt: number): void { updateCivics(this as unknown as CivicSystemHost, dt); }

  /** 屋顶轮廓选择：只依赖 (分区, 楼型, 立面, seed)，同一份数据永远同一种屋顶。 */
  private roofKindFor(building: CityBuilding, facade: number): number { return roofKindFor(this as unknown as BuildingSystemHost, building, facade); }

  /** 地标塔冠顶：金属尖顶 + 三道自发光灯环；日落霓虹主题再加一道向上的光束（进 bloom）。 */
  private buildHeroCrown(hero: BuildingRuntime): void { buildHeroCrown(this as unknown as BuildingSystemHost, hero); }

  private placeHeroCrown(x: number, top: number, z: number, width: number, depth: number, h: number, capped: boolean): void { placeHeroCrown(this as unknown as BuildingSystemHost, x, top, z, width, depth, h, capped); }

  /** 分区驱动立面：downtown 玻璃 / commercial 横带 / residential 窗洞 /
   *  waterfront 混合。无地块信息的楼（不应出现）退回模型层的 hash 立面。 */
  /** 城区地标（S5「每个区也需要有自己的地标建筑物」）：离城区中心最近的空地块上一座三级收分的装饰艺术塔，
   *  墙身取区色粉彩、玻璃带窗、霓虹勾边与塔尖，夜里亮窗（与双子塔同一套 landmarkWindows）。
   *  高度取本区最高会话楼 × 1.15（58–110）——城区天际线的峰值；装饰，不代表会话。 */
  /** 城区地标高度（绝对口径，用户确认）：下限 = 全城最高会话楼 × 1.1（≈40，不低于会话楼），每个会话 +0.16，上限 90（= 180 m）。
   *  2026-10-15 在 2 米比例尺下从「+0.37、上限 160（320 m）」压下来：2000 会话时四个城区全顶到 320 m，是周围楼的 6–10 倍，
   *  还高过所有致敬地标（电视塔 144 m、双子塔 157 m）——地标该是城区的天际线峰值，不是另一座城市。下面的「实测」是旧口径的数。
   *  只随本区会话数增长，别的城区增长不会把它压矮；回放中按「截至游标已开始的会话数」逐层加盖（applyCursor）。
   *  实测（700 模拟会话）：DeepSeek 43 → 56，ZCode 82 → 70，Claude Code 120 → 84，Codex 135 → 90。
   *  曾按「最少 → 最多城区」相对插值：最大城区恒为 90、最小恒为 40，全体同比增长时高度不变，别区增长还会变矮。 */
  districtLandmarkHeight(districtId: string, sessions?: number): number {
    const district = this.model.districts.find((d) => d.id === districtId);
    if (sessions === undefined && district?.visualLandmarkHeight !== undefined) return district.visualLandmarkHeight;
    const own = sessions ?? district?.sessionCount ?? 0;
    const floor = Math.max(30, ...this.model.buildings.map((b) => b.height)) * 1.1;
    return Math.min(90, floor + 0.16 * own);
  }

  private districtLandmarkGroups: THREE.Object3D[] | null = null;
  /** 回放：地标按截至游标已开始的会话数缩放到对应高度（live 时为完整高度）。 */
  private applyDistrictLandmarkGrowth(cursor: number, live: boolean): void { applyDistrictLandmarkGrowth(this as unknown as LandmarkSystemHost, cursor, live); }

  private buildDistrictLandmarks(): void { buildDistrictLandmarks(this as unknown as LandmarkSystemHost); }

  private landValueCache: Map<string, number> | null = null;
  /** 地价驱动形态（S5，用户「同区建筑颜色风格一致，但形态随地块价值变化」）：区内地价前 25% 读作
   *  塔楼（细、退台、塔冠），后 30% 读作板楼/街坊楼（宽、浅）；中段保留数据给的原型；数据地标原样。
   *  楼高不动——token 决定大小，地价只决定长成什么样。 */
  formOf(building: CityBuilding): CityBuilding["archetype"] {
    if (building.archetype === "landmark") return "landmark";
    if (!this.landValueCache) {
      this.landValueCache = new Map();
      // 区内相对地价（百分位）：绝对值在各区都偏低（实测最高 0.55），绝对阈值一栋塔都切不出来；
      // 地价本来就是相对的——区内最贵的四分之一盖塔楼，最便宜的三成盖板楼/街坊楼。
      for (const district of this.layout.districts) {
        const ranked = [...(district.landValue ?? [])].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
        ranked.forEach(([id], index) => this.landValueCache!.set(id, ranked.length > 1 ? index / (ranked.length - 1) : 0.5));
      }
    }
    const percentile = this.landValueCache.get(building.id);
    if (percentile === undefined) return building.archetype;
    return percentile >= 0.75 ? "tower" : percentile < 0.3 ? (building.seed < 0.5 ? "slab" : "block") : building.archetype;
  }

  private percentileOf(building: CityBuilding): number | undefined { return percentileOf(this as unknown as BuildingSystemHost, building); }


  facadeFor(building: CityBuilding): number { return facadeFor(this as unknown as BuildingSystemHost, building); }

  /** 溢出会话的背景楼群：低细节体量块，可数不可点——数据没被丢，只是不占独立地块。 */
  private buildMassing(): void { buildMassing(this as unknown as BuildingSystemHost); }

  /** Deterministic Miami skyline fabric on vacant inner commercial lots.
   *  Decorative only: no session id, label, hit target, growth or HUD count.
   *  Two instanced batches keep the skyline affordable even on low-end GPUs. */
  private buildUrbanContext(): void { buildUrbanContext(this as unknown as BuildingSystemHost); }

  private context: { bodies: THREE.InstancedMesh; crowns: THREE.InstancedMesh; matrices: Float32Array } | null = null;
  private contextTarget = new Float32Array(0);
  private contextProgress = new Float32Array(0);
  private readonly contextScratch = new THREE.Matrix4();
  private readonly contextScale = new THREE.Matrix4();

  /** 背景楼进度 → 矩阵：落成态矩阵左乘「以楼底为原点的 y 缩放」（BOX/塔几何都以底面为原点，直接右乘缩放即可）。 */
  private writeContext(): void { writeContext(this as unknown as BuildingSystemHost); }

  private updateContext(dt: number): void { updateContext(this as unknown as BuildingSystemHost, dt); }

  private buildSeaMountains(): void { buildSeaMountains(this as unknown as TerrainHost); }

  applyFlora(flora: LoadedFlora): void { applyFlora(this as unknown as NatureHost, flora); }

  /** 滨海步道（VICE B3）：沿 promenade 折线的浅色铺装缎带——人行道语义，不进
   *  roadEdges/carPaths（机动车不会开上步道）。单 BufferGeometry，静态缓存段。 */
  /** S3「滨海景观带随用地走」：环岛滨海路在建成区（会话楼 160 内）旁的岸段，向海一侧 9 处铺同一套步道
   *  （粉色铺装 + 白色矮墙 + 路灯）。曾只有海滨那一段 85° 弧有景观带，住宅区一直排到海边、景观带却停了（真机截图）。 */
  private urbanPromenadeSegments(): Vec2[][] { return urbanPromenadeSegments(this as unknown as SeasideHost); }

  private buildPromenade(segments: Vec2[][]): void { buildPromenade(this as unknown as SeasideHost, segments); }

  /** 救生塔（VICE S1）：架高值守小屋 + 平台 + 檐顶 + 楼梯——架高结构是
   *  Lifeguard Tower 的第一特征（不是灯塔的窄圆柱）。条纹为辅助色。夜间
   *  自发光由独立 MeshBasic 材质驱动（不依赖路灯照亮），随 setNightGlow 亮起。
   *  合法沙带内最多 3 座，确定性 seed。 */
  private buildLifeguardTowers(): void { buildLifeguardTowers(this as unknown as SeasideHost); }

  /** 沙滩设施：遮阳伞（伞杆 + 伞面）与躺椅，成组散布在干沙上——真机反馈「看不到沙滩和海滨设施」。
   *  沿连续合法岸段每 ~9 单位一组，位置/颜色由确定性 hash 抖动；救生塔附近留空。 */
  private buildBeachFurniture(): void { buildBeachFurniture(this as unknown as SeasideHost); }

  /** 沙排场 + 沙滩人物。人物是静态的、真实比例（身高 ~1.75，躺椅长 1.9，与之同尺度），
   *  比楼小得多：曾经的街区行人是刻意超比例的人偶，且沿车行路网走（真机：「在公路上走」）。
   *  人形 = 双腿 + 躯干（衣色）+ 双臂 + 头（肤色），两个 InstancedMesh 共用矩阵。 */
  /** 沙滩网格：沿整条海岸线（地形的岸线就是这条 96 点折线）铺贴地色带——浪花 / 湿沙 / 干沙，
   *  每条色带是独立的平面四边形，边缘锐利。海滨段铺全宽（干沙 + 路缘），其余海岸铺窄的自然沙滩；
   *  山坡/悬崖、港口与河口处不铺。曾只有海滨那 85° 一段有沙滩，且画在低分辨率贴图里（真机：糊、少）。
   *  向海一侧延伸到水下 6 单位，水线由水面与地形自然相交给出。 */
  private buildBeachRibbon(): void { buildBeachRibbon(this as unknown as SeasideHost); }

  /** 港口码头（G3「水上活动」）：港口用地朝开阔水面的方向伸出 4 条白色栈桥，两侧泊着游艇/小艇。
   *  曾只有一块灰色港区地坪，水上几乎没有生活（多视角评估）。方向取港口周边最深的一侧，栈桥从岸线起步。 */
  private buildMarina(): void { buildMarina(this as unknown as SeasideHost); }

  /** 红色穿式桁架桥（backlog L-7）：悬索桥之外、跨距 40–160 的过河桥加一套格构桁架——上下弦 + 竖杆 + 交替斜腹杆，
   *  深红涂装。只换造型不改路网（同悬索桥做法）；桥面高度与 buildInfrastructure 一致。 */
  private buildTrussBridges(): void { buildTrussBridges(this as unknown as RoadHost); }

  private buildTrees(): THREE.InstancedMesh { return buildTrees(this as unknown as NatureHost); }

  private buildCars(): { mesh: THREE.InstancedMesh; cars: Car[] } { return buildCars(this as unknown as AmbientHost); }

  private buildBoats(): { mesh: THREE.InstancedMesh; boats: Array<{ path: CarPath; distance: number; speed: number; phase: number; wakeTimer: number }>; wakeMesh: THREE.InstancedMesh; wakes: Array<{ x: number; z: number; birth: number; driftX: number; driftZ: number }> } { return buildBoats(this as unknown as AmbientHost); }

  private buildClouds(): { mesh: THREE.InstancedMesh; clouds: Array<{ x: number; z: number; y: number; speed: number; scale: number }> } { return buildClouds(this as unknown as AmbientHost); }

  private buildAnomalyMarkers(): void { buildAnomalyMarkers(this as unknown as BuildingSystemHost); }

  private buildLabels(): void { buildLabels(this as unknown as UiOverlayHost); }

  private buildWater(): THREE.Mesh { return buildWater(this as unknown as TerrainHost); }

  private buildRuntimes(): void { buildRuntimes(this as unknown as BuildingSystemHost); }

  /** Later session pages: add only new buildings into the existing instanced layer. */
  appendOccupants(model: CityModel, layout: CityLayout): number {
    this.model = model;
    this.layout = layout;
    const zoneById = new Map<string, string>();
    for (const district of layout.districts) {
      for (const [id, parcel] of district.slots) zoneById.set(id, parcel.zone);
    }
    this.zoneById = zoneById;
    if (this.landValueCache) {
      for (const district of layout.districts) {
        const ranked = [...(district.landValue ?? [])].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
        ranked.forEach(([id], index) => {
          if (!this.landValueCache!.has(id)) this.landValueCache!.set(id, ranked.length > 1 ? index / (ranked.length - 1) : 0.5);
        });
      }
    }
    for (const building of model.buildings) {
      const existing = this.runtimeById.get(building.id);
      if (existing) existing.building = building;
    }
    const added = appendRuntimes(this as unknown as BuildingSystemHost);
    CityParts.appendCount += 1;
    return added.length;
  }

  sessionIdForAsset(assetRef: string): string | null {
    for (const building of this.model.buildings) {
      if (building.assetRef === assetRef) return building.id;
    }
    for (const [id, row] of this.model.rows) {
      if (row.asset_ref === assetRef) return id;
    }
    return null;
  }

  applySessionKit(decision: OverlayDecision): boolean {
    const sessionId = this.runtimeById.has(decision.sessionId) ? decision.sessionId : (this.sessionIdForAsset(decision.assetRef) ?? decision.sessionId);
    const runtime = this.runtimeById.get(sessionId);
    if (!runtime) return false;
    const existing = this.kitBySession.get(sessionId);
    if (existing) {
      disposeKitRuntime(existing);
      this.kitBySession.delete(sessionId);
    }
    if (decision.kind === "reset" && decision.parts.length === 0) {
      runtime.settled = !decision.animate;
      if (decision.animate) runtime.display = 0;
      this.applyConstruction(runtime, !decision.animate);
      return true;
    }
    const palette = `#${runtime.paletteWall.getHexString()}`;
    const kit = createKitRuntime({ ...decision, sessionId }, runtime, palette);
    this.group.add(kit.group);
    this.kitBySession.set(sessionId, kit);
    this.hideAll(runtime);
    return true;
  }

  replaySessionKit(sessionId: string): boolean {
    const kit = this.kitBySession.get(sessionId);
    if (!kit) return false;
    replayKitRuntime(kit);
    const runtime = this.runtimeById.get(sessionId);
    if (runtime) this.hideAll(runtime);
    return true;
  }

  kitSnapshot(): Array<{ sessionId: string; assetRef: string; revision: number; buildEventId: string; kind: string; progress: number }> {
    return [...this.kitBySession.entries()].map(([sessionId, kit]) => ({
      sessionId, assetRef: kit.decision.assetRef, revision: kit.decision.revision,
      buildEventId: kit.decision.buildEventId, kind: kit.decision.kind, progress: kit.progress,
    }));
  }

  applySessionEdit(visual: EditVisual): boolean {
    const sessionId = this.runtimeById.has(visual.sessionId) ? visual.sessionId : (this.sessionIdForAsset(visual.assetRef) ?? visual.sessionId);
    const runtime = this.runtimeById.get(sessionId);
    if (!runtime) return false;
    const existing = this.editBySession.get(sessionId);
    if (existing) {
      disposeEditRuntime(existing);
      this.editBySession.delete(sessionId);
    }
    const palette = `#${runtime.paletteWall.getHexString()}`;
    const edit = createEditRuntime({ ...visual, sessionId }, runtime, palette);
    if (!edit) return false;
    this.group.add(edit.group);
    this.editBySession.set(sessionId, edit);
    return true;
  }

  clearSessionEdit(sessionId: string): boolean {
    const edit = this.editBySession.get(sessionId);
    if (!edit) return false;
    disposeEditRuntime(edit);
    this.editBySession.delete(sessionId);
    return true;
  }

  applySessionClaim(visual: ClaimTint): boolean {
    const sessionId = this.runtimeById.has(visual.sessionId) ? visual.sessionId : (this.sessionIdForAsset(visual.assetRef) ?? visual.sessionId);
    const runtime = this.runtimeById.get(sessionId);
    if (!runtime) return false;
    const existing = this.claimBySession.get(sessionId);
    if (existing) {
      disposeClaimRuntime(existing);
      this.claimBySession.delete(sessionId);
    }
    const claim = createClaimRuntime({ ...visual, sessionId }, runtime);
    this.group.add(claim.group);
    this.claimBySession.set(sessionId, claim);
    return true;
  }

  clearSessionClaim(sessionId: string): boolean {
    const claim = this.claimBySession.get(sessionId);
    if (!claim) return false;
    disposeClaimRuntime(claim);
    this.claimBySession.delete(sessionId);
    return true;
  }

  claimSnapshot(): Array<{ sessionId: string; assetRef: string; agentId: string; expiresAt: number }> {
    return [...this.claimBySession.entries()].map(([sessionId, claim]) => ({
      sessionId, assetRef: claim.visual.assetRef, agentId: claim.visual.agentId, expiresAt: claim.visual.expiresAt,
    }));
  }

  editSnapshot(): Array<{ sessionId: string; assetRef: string; kind: string; eventId: string; rule?: string; opacity: number; active: boolean }> {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    return [...this.editBySession.entries()].map(([sessionId, edit]) => {
      const shown = editPresentation(edit.visual, now);
      return {
        sessionId,
        assetRef: edit.visual.assetRef,
        kind: edit.visual.kind,
        eventId: edit.visual.eventId,
        ...(edit.visual.kind === "reject" ? { rule: edit.visual.rule } : {}),
        opacity: shown.opacity,
        active: shown.active,
      };
    });
  }

  occupancySnapshot(): OccupancySnapshot {
    const byId: OccupancySnapshot["byId"] = {};
    for (const runtime of this.runtimes) {
      byId[runtime.building.id] = {
        shaftPrimary: runtime.shaftPrimary, shaftUpper: runtime.shaftUpper, podium: runtime.podium, roof: runtime.roof,
        x: runtime.slot.x, z: runtime.slot.z, facade: runtime.facade,
      };
    }
    return { runtimeCount: this.runtimes.length, shaftUuids: this.shaftMeshes.map((mesh) => mesh.uuid), byId };
  }

  canAppend(nextModel: CityModel, nextLayout: CityLayout): boolean {
    return occupantsCanAppend(this.model, nextModel, this.layout, nextLayout);
  }

  /** 路边双柱广告牌（L-2）：主干道长段中点的外侧净空点，静态摆件；牌位编址接在屋顶牌之后。
   *  与屋顶牌共用四批次网格，但不动施工状态——路面和牌不随会话生长。 */
  private buildRoadsideSigns(rooftopCount: number): void { buildRoadsideSigns(this as unknown as BuildingSystemHost, rooftopCount); }

  private compose(x: number, y: number, z: number, rotationY: number, sx: number, sy: number, sz: number): void {
    this.euler.set(0, rotationY, 0);
    this.quaternion.setFromEuler(this.euler);
    this.positionVector.set(x, y, z);
    this.scaleVector.set(Math.max(sx, 0.0001), Math.max(sy, 0.0001), Math.max(sz, 0.0001));
    this.matrix.compose(this.positionVector, this.quaternion, this.scaleVector);
  }

  /** 施工矩阵：显示进度 display ∈ [0,1] → 主体/退台/屋面/脚手架/天线/吊车。
   *  所有 y 以地基海拔 groundY 为基准 —— 楼长在起伏地形上。 */
  private applyConstruction(runtime: BuildingRuntime, immediate: boolean): void { applyConstruction(this as unknown as BuildingSystemHost, runtime, immediate); }

  private applyCraneArm(runtime: BuildingRuntime, cornerX: number, cornerZ: number, groundY: number, mastHeight: number, armRotation: number): void { applyCraneArm(this as unknown as BuildingSystemHost, runtime, cornerX, cornerZ, groundY, mastHeight, armRotation); }

  private hideAll(runtime: BuildingRuntime): void { hideAll(this as unknown as BuildingSystemHost, runtime); }

  /** pace>0 时按回放节奏夹住升起时长（见 builtFractionAt）；live 或未回放时传 0。 */
  applyCursor(cursor: number, live: boolean, paceMsPerSec = 0): void {
    if (this.drivingFreezeCount) { this.drivingDeferredCursor = [cursor, live, paceMsPerSec]; return; }
    this.cursor = cursor;
    this.live = live;
    (this.layout.civics ?? []).forEach((civic, index) => { this.civicTarget[index] = live || cursor >= civic.unlockAt ? 1 : 0; });
    const context = this.layout.contextBuildings ?? [];
    if (this.contextTarget.length !== context.length) { this.contextTarget = new Float32Array(context.length).fill(1); this.contextProgress = new Float32Array(context.length).fill(1); }
    context.forEach((building, index) => { this.contextTarget[index] = live || cursor >= building.appearAt ? 1 : 0; });
    this.applyDistrictLandmarkGrowth(cursor, live);
    for (const runtime of this.runtimes) {
      runtime.target = builtFractionAt(runtime.building, cursor, live, paceMsPerSec);
      if (live && runtime.building.active) runtime.target = Math.max(runtime.target, runtime.building.builtFraction);
    }
  }

  /** 重建前的显示进度快照：applyModel 把它交给下一份 CityParts——回访的楼保持
   *  高度（不重演生长），新到的楼从 0 长入（分页/失效刷新的「逐步长全」）。 */
  displaySnapshot(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, runtime] of this.runtimeById) out.set(id, runtime.display);
    return out;
  }

  /** display/civicProgress 直接对齐 target：模型重建后的第一步。重建时 display
   *  被初始化为「已完工」（closed 的 builtFraction=1，civic 全 1），回放中若任由
   *  动画循环追赶，整城会先闪满高、再被压回时间轴进度——数据加载不应改变城市
   *  已呈现的样子。 */
  snapToTargets(all = false): void {
    if (this.drivingFreezeCount) { this.drivingDeferredSnap = all || this.drivingDeferredSnap === true; return; }
    this.contextProgress.set(this.contextTarget);
    this.writeContext();
    for (const runtime of this.runtimes) {
      if (!all && !runtime.settled) continue; // 新楼交给 update 循环长入
      runtime.display = runtime.target;
      if (all) runtime.settled = true;
      this.applyConstruction(runtime, true);
    }
    for (let index = 0; index < this.civicTarget.length; index += 1) {
      if (this.civicProgress[index] !== this.civicTarget[index]) {
        this.civicProgress[index] = this.civicTarget[index];
        this.writeCivic(index);
      }
    }
    for (const mesh of this.shaftMeshes) mesh.instanceMatrix.needsUpdate = true;
    this.podiumMesh.instanceMatrix.needsUpdate = true;
    this.decoCornerMesh.instanceMatrix.needsUpdate = true;
    this.decoTrimMesh.instanceMatrix.needsUpdate = true;
    for (const mesh of this.roofProfiles) mesh.instanceMatrix.needsUpdate = true;
    this.gardenTreeMesh.instanceMatrix.needsUpdate = true;
    this.roofMesh.instanceMatrix.needsUpdate = true;
    this.neonMesh.instanceMatrix.needsUpdate = true;
    this.scaffoldMesh.instanceMatrix.needsUpdate = true;
    this.antennaMesh.instanceMatrix.needsUpdate = true; this.cylinderMesh.instanceMatrix.needsUpdate = true;
    this.craneMastMesh.instanceMatrix.needsUpdate = true;
    this.crownFinMesh.instanceMatrix.needsUpdate = true;
    this.crownStripMesh.instanceMatrix.needsUpdate = true;
    this.signPostMesh.instanceMatrix.needsUpdate = true;
    this.signPanelMesh.instanceMatrix.needsUpdate = true;
    this.signFrameMesh.instanceMatrix.needsUpdate = true;
    this.signStripeMesh.instanceMatrix.needsUpdate = true;
  }

  setQualityLevel(level: QualityLevel): void {
    this.cloudMesh.visible = level >= 1;
    this.carKeep = level >= 1 ? 1 : 0.5;
    this.applyCarDensity();
  }

  private applyCarDensity(): void { applyCarDensity(this as unknown as AmbientHost); }

  private placeCar(car: Car, index: number, visible: boolean): void { placeCar(this as unknown as AmbientHost, car, index, visible); }

  /** 航拍时隐藏「计划高度」脚手架壳：低机位下它是悬在天上的半透明大方块。 */
  setScaffoldVisible(visible: boolean): void {
    this.scaffoldMesh.visible = visible;
  }

  /** 拍照用：暂时藏起标签与悬停/选中环（不改 labelsVisible 偏好），返回恢复函数。 */
  hideOverlaysForPhoto(): () => void { return hideOverlaysForPhoto(this as unknown as UiOverlayHost); }

  setLabelsVisible(visible: boolean): void { setLabelsVisible(this as unknown as UiOverlayHost, visible); }

  /** Keep preferences/geometry intact; current daylight is reapplied on release. */
  setBattleClarity(active: boolean): void {
    this.battleClarity = active;
    const presentation = battleClarityPresentation(active);
    for (const label of this.labels) label.visible = this.labelsVisible && presentation.showLabels;
    this.setHovered(this.hoveredId);
    this.setSelected(this.selectedId);
    this.setNightGlow(this.nightGlow);
  }

  private decorTargetsCache: THREE.Object3D[] | null = null;

  /** 非会话建筑的拾取目标（酒店、地标、配套、市政设施、背景楼、聚合楼群、海滨装饰、火山）：
   *  首次使用时沿场景树按网格名收集一次；它们曾不在拾取范围内，点了毫无反应。 */
  get decorTargets(): THREE.Object3D[] { return decorTargets(this as unknown as UiOverlayHost); }

  /** 非会话拾取；已知配套/城区地标返回class#instance，其余兼容旧decor分类。 */
  decorAt(mesh: THREE.Object3D, instanceId: number | undefined, point?: THREE.Vector3): string | null { return decorAt(this as unknown as UiOverlayHost, mesh, instanceId, point); }

  idAt(mesh: THREE.Object3D, instanceId: number): string | null { return idAt(this as unknown as UiOverlayHost, mesh, instanceId); }

  /** 所有楼的锚点（航拍挑主角用）：只读快照，不暴露 runtime。 */
  anchors(): Map<string, { x: number; z: number; height: number; ground: number }> { return anchors(this as unknown as UiOverlayHost); }

  /** 云层材质（昼夜循环驱动透明度）。 */
  get cloudMaterial(): (THREE.Material & { opacity: number }) | null {
    return this.cloudMesh ? (this.cloudMesh.material as THREE.Material & { opacity: number }) : null;
  }

  /** 水色 uniform（昼夜循环驱动深浅两色）。 */
  get waterColors(): { uShallow: { value: THREE.Color }; uDeep: { value: THREE.Color }; uSky: { value: THREE.Color } } | null {
    return this.water ? ((this.water.material as THREE.ShaderMaterial).uniforms as unknown as { uShallow: { value: THREE.Color }; uDeep: { value: THREE.Color }; uSky: { value: THREE.Color } }) : null;
  }

  /** 夜晚城市亮窗：抬升立面自发光，保留 theme 基线下限（白天≈基线不变）。
   *  theme 切换会重设 uSelfLit 基线，下一次昼夜 tick 会在其上再抬升。 */
  private nightGlow = 0;
  private lifeguardGlowMaterial: THREE.MeshBasicMaterial | null = null;
  landmarkWindows: Array<{ material: THREE.MeshLambertMaterial; day: THREE.Texture; lit: THREE.Texture; dayEmissive: THREE.Color }> = [];
  private signageNeonMaterial: THREE.MeshBasicMaterial | null = null;
  private yachtMesh: THREE.InstancedMesh | null = null;
  private yachtIndices: number[] = [];

  setNightGlow(selfLit: number): void { setNightGlow(this as unknown as NightHost, selfLit); }

  /** N5 开车模式解析街灯：由 CityEngine 的游戏相机帧驱动（presentDrivingCamera），
   *  取相机最近 16 盏灯写共享 uniform；夜量随昼夜 tick 的 nightGlow 走。 */
  updateDrivingStreetLamps(camX: number, camZ: number): void {
    const plan = this.nightLights?.plan;
    if (!plan) return;
    updateCarStreetLamps(plan, camX, camZ, nightFactor(this.nightGlow));
  }

  /** 退出开车模式：解析灯清零、贴纸光斑恢复（非开车模式两处都回到从前面貌）。 */
  clearDrivingStreetLamps(): void { clearCarStreetLamps(); }

  /** theme 基线 + 夜晚抬升的合成值（theme 切换后由昼夜 tick 重新应用）。 */
  applySelfLit(themeBase: number): void { applySelfLit(this as unknown as NightHost, themeBase); }

  anchorFor(id: string): { x: number; z: number; height: number; ground: number } | null { return anchorFor(this as unknown as UiOverlayHost, id); }

  /** Interactive framing uses the currently visible growth, not the final tower height. */
  focusAnchorFor(id: string): { x: number; z: number; height: number; ground: number; footprint: number } | null {
    const anchor = this.anchorFor(id), runtime = this.runtimeById.get(id);
    if (!anchor || !runtime) return null;
    const form = this.formOf(runtime.building);
    const footprint = !runtime.slot.blockId.startsWith("hotel:") && (form === "tower" || form === "landmark") ? runtime.building.footprint
      : Math.max(runtime.building.footprint, runtime.slot.width * 0.92, runtime.slot.depth * 0.9);
    const mesh = this.shaftMeshes?.[runtime.facade];
    let visibleHeight = Math.max(1, anchor.height * runtime.display), visibleFootprint = footprint;
    if (mesh && runtime.shaftPrimary >= 0) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) {
        const matrix = new THREE.Matrix4();
        mesh.getMatrixAt(runtime.shaftPrimary, matrix);
        const box = mesh.geometry.boundingBox.clone().applyMatrix4(matrix);
        const size = box.getSize(new THREE.Vector3());
        visibleFootprint = Math.max(visibleFootprint, size.x, size.z);
        visibleHeight = Math.max(visibleHeight, box.max.y - anchor.ground);
      }
    }
    return { ...anchor, footprint: visibleFootprint, height: visibleHeight };
  }

  setHovered(id: string | null): void { setHovered(this as unknown as UiOverlayHost, id); }

  setSelected(id: string | null): void { setSelected(this as unknown as UiOverlayHost, id); }

  /** 每帧增量更新。返回是否有矩阵写入（供引擎决定是否强制重绘）。 */
  update(dt: number, elapsed: number): boolean {
    if (this.drivingFreezeCount) return false;
    if (this.waterUniforms) this.waterUniforms.uTime.value = elapsed;
    if (this.flagTime) this.flagTime.value = elapsed;
    this.updateCivics(dt);
    this.updateContext(dt);
    for (const spinner of this.landmarkSpinners) spinner.object.rotation[spinner.axis] += spinner.speed * dt;

    let dirty = false;
    const rate = Math.min(1, dt * 1.35);
    for (const runtime of this.runtimes) {
      const kit = this.kitBySession.get(runtime.building.id);
      if (kit && kit.decision.kind === "set") {
        this.hideAll(runtime);
        continue;
      }
      if (Math.abs(runtime.display - runtime.target) > 0.0012) {
        runtime.display += (runtime.target - runtime.display) * rate;
        this.applyConstruction(runtime, false);
        dirty = true;
      } else if (runtime.display !== runtime.target) {
        runtime.display = runtime.target;
        runtime.settled = true;
        this.applyConstruction(runtime, false);
        dirty = true;
      }
    }
    for (const kit of this.kitBySession.values()) {
      if (stepKitRuntime(kit, dt)) dirty = true;
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    for (const [sessionId, edit] of [...this.editBySession]) {
      if (stepEditRuntime(edit, now)) dirty = true;
      if (edit.visual.kind === "reject" && !editPresentation(edit.visual, now).active) {
        disposeEditRuntime(edit);
        this.editBySession.delete(sessionId);
        dirty = true;
      }
    }
    const nowSecs = Math.floor(Date.now() / 1000);
    for (const [sessionId, claim] of [...this.claimBySession]) {
      if (claim.visual.expiresAt <= nowSecs) {
        disposeClaimRuntime(claim);
        this.claimBySession.delete(sessionId);
        dirty = true;
      }
    }
    if (dirty || Number.isNaN(this.cursor)) {
      for (const mesh of this.shaftMeshes) mesh.instanceMatrix.needsUpdate = true;
      this.podiumMesh.instanceMatrix.needsUpdate = true;
      this.decoCornerMesh.instanceMatrix.needsUpdate = true;
      this.decoTrimMesh.instanceMatrix.needsUpdate = true;
      for (const mesh of this.roofProfiles) mesh.instanceMatrix.needsUpdate = true;
      this.gardenTreeMesh.instanceMatrix.needsUpdate = true;
      this.roofMesh.instanceMatrix.needsUpdate = true;
      this.neonMesh.instanceMatrix.needsUpdate = true;
      this.scaffoldMesh.instanceMatrix.needsUpdate = true;
      this.antennaMesh.instanceMatrix.needsUpdate = true; this.cylinderMesh.instanceMatrix.needsUpdate = true;
      this.craneMastMesh.instanceMatrix.needsUpdate = true;
      this.crownFinMesh.instanceMatrix.needsUpdate = true;
      this.crownStripMesh.instanceMatrix.needsUpdate = true;
      this.signPostMesh.instanceMatrix.needsUpdate = true;
      this.signPanelMesh.instanceMatrix.needsUpdate = true;
      this.signFrameMesh.instanceMatrix.needsUpdate = true;
      this.signStripeMesh.instanceMatrix.needsUpdate = true;
    }

    // 吊车臂：活跃楼的节奏 = 繁忙度。
    for (const runtime of this.runtimes) {
      if (runtime.craneArm < 0 || runtime.display <= 0.002 || (runtime.craneX === 0 && runtime.craneZ === 0)) continue;
      const spin = (0.25 + runtime.building.busyness * 0.85) * dt;
      runtime.cranePhase += spin;
      const mastHeight = runtime.building.height * 1.02 + 6.5;
      // 曾在此处重算旧公式（x + fp*0.72，无 yaw/楼宽），把 applyConstruction 里修正的立柱位置
      // 每帧覆盖回去：吊臂绕着错误的点转，与立柱脱节。
      const cornerX = runtime.craneX;
      const cornerZ = runtime.craneZ;
      this.applyCraneArm(runtime, cornerX, cornerZ, runtime.groundY, mastHeight, 0);
      this.craneArmMesh.instanceMatrix.needsUpdate = true;
      // 吊车顶警示灯。
      if (runtime.beacon >= 0) {
        const blink = 0.55 + 0.45 * Math.sin(elapsed * 2.4 + runtime.blinkPhase);
        this.compose(cornerX, runtime.groundY + mastHeight + 0.3, cornerZ, 0, blink, blink, blink);
        this.beaconMesh.setMatrixAt(runtime.beacon, this.matrix);
        this.beaconMesh.instanceMatrix.needsUpdate = true;
      }
    }

    // 车辆。
    let carsMoved = false;
    this.cars.forEach((car, index) => {
      if (car.speed === 0) return;
      car.distance += car.speed * dt;
      this.placeCar(car, index, true);
      carsMoved = true;
    });
    if (carsMoved) this.carMesh.instanceMatrix.needsUpdate = true;

    // 船只（沿海岸航道折线推进 + 起伏）+ 尾迹泡沫在船尾持续吐出。
    let wakeCursor = 0;
    this.boats.forEach((boat, index) => {
      boat.distance += boat.speed * dt;
      const sample = samplePolyline(boat.path, boat.distance);
      const bob = Math.sin(elapsed * 0.9 + boat.phase) * 0.12;
      this.compose(sample.x, -0.3 + bob, sample.z, Math.atan2(-sample.dz, sample.dx), 1, 1, 1);
      this.boatMesh.setMatrixAt(index, this.matrix);
      boat.wakeTimer -= dt;
      if (boat.wakeTimer <= 0) {
        boat.wakeTimer = 0.3 + 0.08 * Math.sin(elapsed * 1.7 + boat.phase);
        const puff = this.wakes[wakeCursor];
        wakeCursor = (wakeCursor + 1) % this.wakes.length;
        const side = Math.sin(elapsed * 5.3 + boat.phase + index);
        puff.x = sample.x - sample.dx * 6.4 - sample.dz * side * 1.6;
        puff.z = sample.z - sample.dz * 6.4 + sample.dx * side * 1.6;
        puff.birth = elapsed;
        puff.driftX = -sample.dx * 0.5 - sample.dz * side * 0.35;
        puff.driftZ = -sample.dz * 0.5 + sample.dx * side * 0.35;
      }
    });
    this.boatMesh.instanceMatrix.needsUpdate = true;
    // 飞桥游艇（VICE S3）：在对应船位渲染游艇（隐藏原船实例色→改为游艇色）。
    if (this.yachtMesh && this.yachtIndices.length) {
      for (let y = 0; y < this.yachtIndices.length; y += 1) {
        const boat = this.boats[this.yachtIndices[y]];
        if (!boat) continue;
        const sample = samplePolyline(boat.path, boat.distance);
        const bob = Math.sin(elapsed * 0.9 + boat.phase) * 0.12;
        this.compose(sample.x, -0.3 + bob, sample.z, Math.atan2(-sample.dz, sample.dx), 1, 1, 1);
        this.yachtMesh.setMatrixAt(y, this.matrix);
      }
      this.yachtMesh.instanceMatrix.needsUpdate = true;
    }
    // 尾迹推进：放大 + 漂移，寿命 2.8s 后藏起。
    let wakesMoved = false;
    for (let index = 0; index < this.wakes.length; index += 1) {
      const puff = this.wakes[index];
      if (puff.birth < 0) continue;
      const age = elapsed - puff.birth;
      if (age > 2.8) {
        puff.birth = -1;
        this.compose(0, -60, 0, 0, 0.0001, 0.0001, 0.0001);
      } else {
        puff.x += puff.driftX * dt;
        puff.z += puff.driftZ * dt;
        this.compose(puff.x, -0.44, puff.z, age * 0.5, 1.1 + age * 2.3, 1, 1.1 + age * 2.3);
      }
      this.wakeMesh.setMatrixAt(index, this.matrix);
      wakesMoved = true;
    }
    if (wakesMoved) this.wakeMesh.instanceMatrix.needsUpdate = true;

    // 云。
    const bounds = this.layout.boundsRadius + 60;
    this.clouds.forEach((cloud, index) => {
      cloud.x += cloud.speed * dt;
      if (cloud.x > bounds) cloud.x = -bounds;
      const blob = 9.5 * cloud.scale;
      this.compose(cloud.x, cloud.y, cloud.z, 0, blob * 1.6, blob * 0.34, blob * 0.8);
      this.cloudMesh.setMatrixAt(index, this.matrix);
    });
    if (this.cloudMesh.visible) this.cloudMesh.instanceMatrix.needsUpdate = true;

    // 异常信标。
    for (const marker of this.anomalyMarkers) {
      marker.mesh.position.y = marker.baseY + Math.sin(elapsed * 1.4 + marker.phase) * 0.6;
      marker.mesh.rotation.y = elapsed * 0.9 + marker.phase;
      marker.mesh.rotation.x = Math.sin(elapsed * 0.7 + marker.phase) * 0.18;
      const pulse = 0.86 + 0.14 * Math.sin(elapsed * 2.6 + marker.phase);
      marker.ring.scale.set(pulse, 1, pulse);
      (marker.ring.material as THREE.MeshBasicMaterial).opacity = 0.32 + 0.3 * (0.5 + 0.5 * Math.sin(elapsed * 2.6 + marker.phase));
    }

    // 悬停/选中环呼吸（透明度脉动，不改 scale——scale 由选中目标决定）。
    const ringPulse = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(elapsed * 3.2));
    if (this.hoverRing.visible) (this.hoverRing.material as THREE.MeshBasicMaterial).opacity = ringPulse;
    if (this.selectRing.visible) (this.selectRing.material as THREE.MeshBasicMaterial).opacity = 0.6 + 0.3 * (0.5 + 0.5 * Math.sin(elapsed * 2.4));

    return dirty || carsMoved;
  }

  private captureAnimationOrigin(): void {
    for (const car of this.cars) { originOf(car, car.distance); baseSpeedOf(car); }
    for (const boat of this.boats) originOf(boat, boat.distance);
    for (const cloud of this.clouds) originOf(cloud, cloud.x);
    for (const spinner of this.landmarkSpinners) originOf(spinner, spinner.object.rotation[spinner.axis]);
  }

  /** 把所有随帧累加的动画状态放回起点，楼与配套直接落到目标进度（不再有生长插值）。
   *  胶片导出开拍前调用：同一份数据 + seed，任何时候导出都从同一个状态开始。 */
  resetAnimation(): void {
    if (this.drivingFreezeCount) { this.drivingDeferredReset = true; return; }
    this.contextProgress.set(this.contextTarget);
    this.writeContext();
    for (const car of this.cars) car.distance = originOf(car, car.distance);
    this.applyCarDensity();
    for (const boat of this.boats) boat.distance = originOf(boat, boat.distance);
    for (const cloud of this.clouds) cloud.x = originOf(cloud, cloud.x);
    for (const spinner of this.landmarkSpinners) spinner.object.rotation[spinner.axis] = originOf(spinner, spinner.object.rotation[spinner.axis]);
    // 每栋都重写一遍实例矩阵（不只是进度变了的）：吊臂角度、信标闪烁等姿态只在楼可见时逐帧写，
    // 楼一旦藏起就停在上一部片子留下的样子——只按进度判脏会漏掉它们。
    for (const runtime of this.runtimes) {
      runtime.cranePhase = runtime.building.seed * Math.PI * 2;
      runtime.display = runtime.target;
      runtime.settled = true;
      this.applyConstruction(runtime, false);
    }
    for (const mesh of [...this.shaftMeshes, ...this.roofProfiles, this.podiumMesh, this.decoCornerMesh, this.decoTrimMesh, this.gardenTreeMesh, this.roofMesh, this.neonMesh, this.scaffoldMesh, this.antennaMesh, this.craneMastMesh, this.craneArmMesh, this.beaconMesh]) {
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (let index = 0; index < this.civicTarget.length; index += 1) {
      if (this.civicProgress[index] === this.civicTarget[index]) continue;
      this.civicProgress[index] = this.civicTarget[index];
      this.writeCivic(index);
    }
  }

  districtAnchor(districtId: string): { x: number; z: number; y: number; radius: number } | null {
    const district = this.layout.districts.find((item) => item.id === districtId);
    return district ? { x: district.center.x, z: district.center.z, y: district.plaza.y, radius: district.radius } : null;
  }

  dispose(): void {
    this.drivingDisposed = true;
    for (const release of this.drivingModelHolds.splice(0)) release();
    // 只拆动态层：静态城（地形/基建/车船云）留在模块级缓存，同一 seed 的下一次
    // 重建直接复用；换 seed 时由构造函数统一释放旧缓存。
    this.group.removeFromParent();
    if (staticCityCache && staticCityCache.seed === this.layout.seed) {
      this.group.remove(staticCityCache.group);
    }
    for (const kit of this.kitBySession.values()) disposeKitRuntime(kit);
    this.kitBySession.clear();
    for (const edit of this.editBySession.values()) disposeEditRuntime(edit);
    this.editBySession.clear();
    for (const claim of this.claimBySession.values()) disposeClaimRuntime(claim);
    this.claimBySession.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
