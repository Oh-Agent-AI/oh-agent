/**
 * 会话楼系统：自 cityParts.ts 原样搬出（纯搬迁，见 docs/CITY_ENGINE_SPLIT_SPEC.md §4-6）。
 * 函数体与原方法逐字一致，仅 `this.` → `host.`；cityParts 里保留同名一行转发。
 */
import { atLeast } from "../roadStandard";
import { m, REAL } from "../worldScale";
import * as THREE from "three";
import { builtFractionAt, hashSeed, type CityBuilding, type CityModel } from "../../cityModel";
import { HOTEL_CROWN_MAX_FINS, hotelCrownPlan, type CrownPiece } from "../cityHotelCrown";
import { roadsideSignPlan, rooftopSignPlan, type RooftopSignPlan } from "../citySkylineProps";
import type { CityLayout, DistrictLayout, Parcel, Vec2 } from "../cityLayout";
import { activeTheme } from "../cityTheme";
import { makeDecoFacadeTexture, makeFacadeTexture, paletteFor } from "../cityTextures";
import { SegmentIndex } from "../cityPlan";
import { LIGHT_BUDGET, useOfZone } from "../cityLightBudget";
import { roadPaintPlan } from "../cityRoadPaint";
import { BOX, CYLINDER, artDecoTowerGeometry } from "../render/shared";
import type { BuildingRuntime } from "../render/types";

export interface BuildingSystemHost {
  model: CityModel;
  layout: CityLayout;
  group: THREE.Group;
  disposables: Array<{ dispose: () => void }>;
  runtimes: BuildingRuntime[];
  runtimeById: Map<string, BuildingRuntime>;
  shaftMeshes: THREE.InstancedMesh[];
  zoneById: Map<string, string>;
  shaftIdByInstance: Array<Map<number, string>>;
  podiumMesh: THREE.InstancedMesh;
  roofMesh: THREE.InstancedMesh;
  decoTrimMesh: THREE.InstancedMesh;
  decoCornerMesh: THREE.InstancedMesh;
  roofProfiles: THREE.InstancedMesh[];
  gardenTreeMesh: THREE.InstancedMesh;
  heroParts: { spire: THREE.Mesh; rings: THREE.Mesh[]; beam: THREE.Mesh | null } | null;
  neonMesh: THREE.InstancedMesh;
  scaffoldMesh: THREE.InstancedMesh;
  antennaMesh: THREE.InstancedMesh;
  cylinderMesh: THREE.InstancedMesh;
  beaconMesh: THREE.InstancedMesh;
  craneMastMesh: THREE.InstancedMesh;
  craneArmMesh: THREE.InstancedMesh;
  crownFinMesh: THREE.InstancedMesh;
  crownStripMesh: THREE.InstancedMesh;
  signPostMesh: THREE.InstancedMesh;
  signPanelMesh: THREE.InstancedMesh;
  signFrameMesh: THREE.InstancedMesh;
  signStripeMesh: THREE.InstancedMesh;
  signPostCount: number;
  anomalyMarkers: Array<{ mesh: THREE.Mesh; ring: THREE.Mesh; baseY: number; phase: number }>;
  matrix: THREE.Matrix4;
  color: THREE.Color;
  hsl: { h: number; s: number; l: number };
  previousDisplays: Map<string, number> | null;
  landValueCache: Map<string, number> | null;
  context: { bodies: THREE.InstancedMesh; crowns: THREE.InstancedMesh; matrices: Float32Array } | null;
  contextTarget: Float32Array;
  contextProgress: Float32Array;
  contextScratch: THREE.Matrix4;
  contextScale: THREE.Matrix4;
  makeInstanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh;
  compose(x: number, y: number, z: number, rotationY: number, sx: number, sy: number, sz: number): void;
  formOf(building: CityBuilding): CityBuilding["archetype"];
  buildGroundSpill(): void;
  roofKindFor(building: CityBuilding, facade: number): number;
  facadeFor(building: CityBuilding): number;
  percentileOf(building: CityBuilding): number | undefined;
  buildHeroCrown(hero: BuildingRuntime): void;
  placeHeroCrown(x: number, top: number, z: number, width: number, depth: number, h: number, capped: boolean): void;
  buildRoadsideSigns(rooftopCount: number): void;
  applyConstruction(runtime: BuildingRuntime, immediate: boolean): void;
  applyCraneArm(runtime: BuildingRuntime, cornerX: number, cornerZ: number, groundY: number, mastHeight: number, armRotation: number): void;
  hideAll(runtime: BuildingRuntime): void;
  writeContext(): void;
}

type RuntimeCursors = {
  podiumCount: number;
  roofCount: number;
  scaffoldCount: number;
  antennaCount: number;
  beaconCount: number;
  craneCount: number;
  cylinderCount: number;
  shaftCursor: number[];
  decoCursor: number;
  crownCursor: number;
  crownFinCursor: number;
  signCursor: number;
  allowRooftopSigns: boolean;
};

/** Grow an InstancedMesh in place so later session pages can add instances without replacing the mesh. */
export function ensureInstancedCapacity(mesh: THREE.InstancedMesh, needed: number): void {
  const max = mesh.instanceMatrix.count;
  if (needed <= max) return;
  const nextMax = Math.max(needed, Math.ceil(max * 1.5) || needed);
  const nextMatrix = new THREE.InstancedBufferAttribute(new Float32Array(nextMax * 16), 16);
  nextMatrix.setUsage(THREE.DynamicDrawUsage);
  (nextMatrix.array as Float32Array).set(mesh.instanceMatrix.array as Float32Array);
  mesh.instanceMatrix = nextMatrix;
  if (mesh.instanceColor) {
    const nextColor = new THREE.InstancedBufferAttribute(new Float32Array(nextMax * 3), 3);
    (nextColor.array as Float32Array).set(mesh.instanceColor.array as Float32Array);
    mesh.instanceColor = nextColor;
  }
  const geometry = mesh.geometry;
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name);
    if (!(attr as THREE.BufferAttribute & { isInstancedBufferAttribute?: boolean }).isInstancedBufferAttribute) continue;
    if (attr.count >= nextMax) continue;
    const grown = new THREE.InstancedBufferAttribute(new Float32Array(nextMax * attr.itemSize), attr.itemSize);
    (grown.array as Float32Array).set(attr.array as Float32Array);
    geometry.setAttribute(name, grown);
  }
}

/** Same geography, existing buildings still at the same parcels, and the next model only adds occupants. */
export function occupantsCanAppend(previous: CityModel, next: CityModel, prevLayout: CityLayout, nextLayout: CityLayout): boolean {
  if (next.buildings.length <= previous.buildings.length) return false;
  if (nextLayout.seed !== prevLayout.seed || nextLayout.scaleTier !== prevLayout.scaleTier) return false;
  const nextIds = new Set(next.buildings.map((building) => building.id));
  const prevSlots = new Map(prevLayout.districts.flatMap((district) => [...district.slots]));
  const nextSlots = new Map(nextLayout.districts.flatMap((district) => [...district.slots]));
  for (const building of previous.buildings) {
    if (!nextIds.has(building.id)) return false;
    const prevSlot = prevSlots.get(building.id);
    if (!prevSlot) continue;
    const nextSlot = nextSlots.get(building.id);
    if (!nextSlot || nextSlot.id !== prevSlot.id || nextSlot.x !== prevSlot.x || nextSlot.z !== prevSlot.z) return false;
  }
  return true;
}

function emptyCursors(allowRooftopSigns: boolean): RuntimeCursors {
  return {
    podiumCount: 0, roofCount: 0, scaffoldCount: 0, antennaCount: 0, beaconCount: 0, craneCount: 0, cylinderCount: 0,
    shaftCursor: [0, 0, 0, 0], decoCursor: 0, crownCursor: 0, crownFinCursor: 0, signCursor: 0, allowRooftopSigns,
  };
}

function cursorsFromHost(host: BuildingSystemHost): RuntimeCursors {
  const cursors = emptyCursors(false);
  cursors.podiumCount = host.podiumMesh.count;
  cursors.roofCount = host.roofMesh.count;
  cursors.scaffoldCount = host.scaffoldMesh.count;
  cursors.antennaCount = host.antennaMesh.count;
  cursors.beaconCount = host.beaconMesh.count;
  cursors.craneCount = host.craneMastMesh.count;
  cursors.cylinderCount = host.cylinderMesh.count;
  host.shaftMeshes.forEach((mesh, variant) => { cursors.shaftCursor[variant] = mesh.count; });
  cursors.decoCursor = host.decoCornerMesh.count;
  cursors.crownFinCursor = host.crownFinMesh.count;
  for (const runtime of host.runtimes) {
    if (runtime.crownBase >= 0) cursors.crownCursor = Math.max(cursors.crownCursor, runtime.crownBase + 1);
    if (runtime.signBase >= 0) cursors.signCursor = Math.max(cursors.signCursor, runtime.signBase + 1);
  }
  return cursors;
}

function placeRuntime(host: BuildingSystemHost, building: CityBuilding, district: DistrictLayout, slot: Parcel, cursors: RuntimeCursors, fromAppend: boolean): BuildingRuntime {
      const palette = paletteFor(building.districtId);
      const runtime: BuildingRuntime = {
        building,
        slot,
        facade: -1,
        groundY: district.grounds.get(building.id) ?? 0,
        paletteWall: new THREE.Color(palette.wall).multiplyScalar(0.92 + building.seed * 0.16),
        display: fromAppend ? 0 : (host.previousDisplays?.get(building.id) ?? 0),
        target: building.builtFraction,
        settled: fromAppend ? false : (host.previousDisplays ? host.previousDisplays.has(building.id) : true),
        district,
        shaftPrimary: -1,
        shaftUpper: -1,
        podium: -1,
        roof: -1,
        scaffold: -1,
        antenna: -1,
        beacon: -1,
        craneMast: -1,
        craneArm: -1,
        cranePhase: building.seed * Math.PI * 2,
        craneX: 0,
        craneZ: 0,
        blinkPhase: hashSeed(`blink:${building.id}`) * Math.PI * 2,
        deco: -1,
        roofKind: 0,
        hero: false,
        cylinder: -1,
        crownBase: -1,
        crown: null,
        signBase: -1,
        signPlan: null,
      };

      runtime.facade = host.facadeFor(building);
      if (runtime.facade === 3) {
        ensureInstancedCapacity(host.decoCornerMesh, cursors.decoCursor + 1);
        ensureInstancedCapacity(host.decoTrimMesh, (cursors.decoCursor + 1) * 2);
        runtime.deco = cursors.decoCursor;
        cursors.decoCursor += 1;
        // 装饰艺术楼墙面用执行环境强调色的粉彩版（而不是执行环境的浅墙色）：浅墙色在黄昏暖光下被压成灰，
        // 海滨要的是一眼能认出的粉、薄荷、青、紫。
        runtime.paletteWall = new THREE.Color(palette.accent).lerp(new THREE.Color("#ffffff"), 0.52).multiplyScalar(0.96 + building.seed * 0.08);
        // Ocean Drive 街墙地块：墙面按楼在风格圣经粉彩里逐栋变化（一条街同一执行环境，整排一个色读不出 Ocean Drive）；
        // 执行环境身份留在下面的女儿墙/遮阳棚强调色与屋顶上。
        if (runtime.slot.blockId.startsWith("oceandrive:")) {
          const pastels = ["#f08b92", "#a5d8c3", "#f2d8ae", "#9fd6e0", "#f5e3a3", "#e7b8d8"];
          runtime.paletteWall = new THREE.Color(pastels[Math.floor(building.seed * 997) % pastels.length]);
        }
        // 转角柱与墙同色略亮；女儿墙与遮阳棚用执行环境强调色的粉彩版——海滨一眼看出是哪个执行环境。
        const accent = new THREE.Color(palette.accent).lerp(new THREE.Color("#ffffff"), 0.35);
        host.decoCornerMesh.setColorAt(runtime.deco, runtime.paletteWall.clone().multiplyScalar(1.06));
        host.decoTrimMesh.setColorAt(runtime.deco * 2, accent);
        host.decoTrimMesh.setColorAt(runtime.deco * 2 + 1, accent.clone().multiplyScalar(0.92));
      }
      const mesh = host.shaftMeshes[runtime.facade];
      const instanceMap = host.shaftIdByInstance[runtime.facade];
      const wantsUpper = host.formOf(building) === "tower" || host.formOf(building) === "landmark";
      const zone = host.zoneById.get(building.id);
      if (host.formOf(building) === "tower" && zone !== "waterfront" && hashSeed(`cylinder:${building.id}`) < 0.14 && cursors.cylinderCount < 64) {
        ensureInstancedCapacity(host.cylinderMesh, cursors.cylinderCount + 1);
        runtime.cylinder = cursors.cylinderCount; cursors.cylinderCount += 1;
      }
      ensureInstancedCapacity(mesh, cursors.shaftCursor[runtime.facade] + (wantsUpper ? 2 : 1));
      runtime.shaftPrimary = cursors.shaftCursor[runtime.facade];
      mesh.setColorAt(runtime.shaftPrimary, runtime.paletteWall);
      (mesh.geometry.getAttribute("aFloors") as THREE.InstancedBufferAttribute).setX(runtime.shaftPrimary, Math.max(2, Math.round(building.height / m(REAL.floorHeight))));
      (mesh.geometry.getAttribute("aLight") as THREE.InstancedBufferAttribute).setXY(runtime.shaftPrimary, useOfZone(zone) === "office" ? 1 : 0, building.active ? 1 : 0);
      instanceMap.set(runtime.shaftPrimary, building.id);
      cursors.shaftCursor[runtime.facade] += 1;
      if (wantsUpper) {
        runtime.shaftUpper = cursors.shaftCursor[runtime.facade];
        mesh.setColorAt(runtime.shaftUpper, runtime.paletteWall.clone().multiplyScalar(0.94));
        (mesh.geometry.getAttribute("aFloors") as THREE.InstancedBufferAttribute).setX(runtime.shaftUpper, Math.max(2, Math.round((building.height * 0.28) / m(REAL.floorHeight))));
        (mesh.geometry.getAttribute("aLight") as THREE.InstancedBufferAttribute).setXY(runtime.shaftUpper, useOfZone(zone) === "office" ? 1 : 0, building.active ? 1 : 0);
        instanceMap.set(runtime.shaftUpper, building.id);
        cursors.shaftCursor[runtime.facade] += 1;
      }

      const needsPodium = host.formOf(building) !== "tower" && host.formOf(building) !== "landmark";
      if (needsPodium) {
        ensureInstancedCapacity(host.podiumMesh, cursors.podiumCount + 1);
        runtime.podium = cursors.podiumCount;
        host.podiumMesh.setColorAt(cursors.podiumCount, runtime.paletteWall.clone().multiplyScalar(0.88));
        cursors.podiumCount += 1;
      }
      ensureInstancedCapacity(host.roofMesh, cursors.roofCount + 1);
      ensureInstancedCapacity(host.neonMesh, cursors.roofCount + 1);
      ensureInstancedCapacity(host.scaffoldMesh, cursors.scaffoldCount + 1);
      ensureInstancedCapacity(host.gardenTreeMesh, (cursors.roofCount + 1) * 3);
      for (const profile of host.roofProfiles) ensureInstancedCapacity(profile, cursors.roofCount + 1);
      runtime.roof = cursors.roofCount;
      host.roofMesh.setColorAt(cursors.roofCount, new THREE.Color(palette.roof).multiplyScalar(0.94 + building.seed * 0.12));
      runtime.roofKind = host.roofKindFor(building, runtime.facade);
      const roofColor = new THREE.Color(palette.roof).multiplyScalar(0.94 + building.seed * 0.12);
      const profileColors = [roofColor, new THREE.Color(palette.accent).lerp(new THREE.Color("#e8eef0"), 0.55), runtime.paletteWall.clone().multiplyScalar(0.96), new THREE.Color("#7fae6a")];
      host.roofProfiles.forEach((mesh, index) => mesh.setColorAt(cursors.roofCount, profileColors[index]));
      // 乘 3.2 让亮度越过 bloom 阈值（MeshBasicMaterial 不吃光照，toneMapped=false 保留 HDR 值）。
      // N1：霓虹描边只留给高楼与酒店冠，普通会话楼不再每栋一圈彩边（荧光玩具感）；其余实例色置黑 = 不发光。
      host.neonMesh.setColorAt(cursors.roofCount, new THREE.Color(palette.accent).multiplyScalar(building.height >= 24 || slot.blockId.startsWith("hotel:") ? LIGHT_BUDGET.neon.roof : 0));
      cursors.roofCount += 1;
      // 海滨酒店冠（L-1）：方案在建模期算一次存住；冠底霓虹带走独立实例（neonMesh 与 roofCount
      // 是 1:1 索引，每楼可变条数会破坏该映射）。
      if (slot.blockId.startsWith("hotel:")) {
        const plan = hotelCrownPlan(slot.width, slot.depth, building.height, building.seed);
        if (plan) {
          runtime.crown = plan;
          runtime.crownBase = cursors.crownCursor;
          ensureInstancedCapacity(host.crownFinMesh, cursors.crownFinCursor + plan.fins.length);
          ensureInstancedCapacity(host.crownStripMesh, cursors.crownCursor + 1);
          cursors.crownFinCursor += plan.fins.length;
          host.crownStripMesh.setColorAt(cursors.crownCursor, new THREE.Color(palette.accent).multiplyScalar(3.2));
          cursors.crownCursor += 1;
        }
      } else if (cursors.allowRooftopSigns && runtime.roofKind === 0 && (slot.zone === "commercial" || slot.zone === "downtown" || (host.percentileOf(building) ?? 0) >= 0.6) && building.height >= 18 && cursors.signCursor < 24) {
        // 屋顶立牌（L-2）：商业区高楼的尺度符号；已有尖顶/退台冠的楼让位（roofKind ≠ 0 不立牌）。
        // roofY 传 0：模块给的件 y 都是「屋顶面相对高度」，写矩阵时再加地面 + 楼高。
        // 分页追加不再新立屋顶牌：路边牌已从第一页的 rooftopCount 起编址，插入会撞号。
        const plan = rooftopSignPlan(slot.width, slot.depth, 0, building.seed);
        if (plan) {
          runtime.signPlan = plan;
          runtime.signBase = cursors.signCursor;
          const frameColor = new THREE.Color(palette.accent).multiplyScalar(3.2);
          plan.frame.forEach((_, k) => host.signFrameMesh.setColorAt(cursors.signCursor * 4 + k, frameColor));
          const stripeColors = [new THREE.Color(palette.accent).multiplyScalar(2.4), new THREE.Color("#f8f4ea").multiplyScalar(2.4), new THREE.Color(palette.roof).multiplyScalar(2.4)];
          plan.stripes.forEach((_, k) => host.signStripeMesh.setColorAt(cursors.signCursor * 3 + k, stripeColors[k % 3]));
          cursors.signCursor += 1;
        }
      }
      runtime.scaffold = cursors.scaffoldCount;
      cursors.scaffoldCount += 1;
      // C-2 轮廓配件：≥24 高、无尖顶冠（roofKind 0）的楼按种子约三成立天线 + 航空灯，打断板楼单调的天际线（backlog C-2）。
      const roofline = runtime.roofKind === 0 && !slot.blockId.startsWith("hotel:") && building.height >= 24 && hashSeed(`roofline:${building.id}`) < 0.32;
      if ((host.formOf(building) === "landmark" || roofline) && cursors.antennaCount < 94) {
        ensureInstancedCapacity(host.antennaMesh, cursors.antennaCount + 1);
        ensureInstancedCapacity(host.beaconMesh, cursors.beaconCount + 1);
        runtime.antenna = cursors.antennaCount;
        cursors.antennaCount += 1;
        runtime.beacon = cursors.beaconCount;
        cursors.beaconCount += 1;
      }
      if (building.active && cursors.craneCount < 46) {
        ensureInstancedCapacity(host.craneMastMesh, cursors.craneCount + 1);
        ensureInstancedCapacity(host.craneArmMesh, cursors.craneCount + 1);
        runtime.craneMast = cursors.craneCount;
        runtime.craneArm = cursors.craneCount;
        cursors.craneCount += 1;
      }

      host.runtimes.push(runtime);
      host.runtimeById.set(building.id, runtime);
      return runtime;
}

function commitRuntimeCounts(host: BuildingSystemHost, cursors: RuntimeCursors, withRoadsideSigns: boolean): void {
    host.shaftMeshes.forEach((mesh, variant) => {
      mesh.count = cursors.shaftCursor[variant];
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    host.podiumMesh.count = cursors.podiumCount;
    if (host.podiumMesh.instanceColor) host.podiumMesh.instanceColor.needsUpdate = true;
    host.roofMesh.count = cursors.roofCount;
    for (const mesh of host.roofProfiles) {
      mesh.count = cursors.roofCount;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    host.gardenTreeMesh.count = cursors.roofCount * 3;
    host.neonMesh.count = activeTheme().neon ? cursors.roofCount : 0;
    if (host.neonMesh.instanceColor) host.neonMesh.instanceColor.needsUpdate = true;
    if (host.roofMesh.instanceColor) host.roofMesh.instanceColor.needsUpdate = true;
    host.scaffoldMesh.count = cursors.scaffoldCount;
    host.antennaMesh.count = cursors.antennaCount;
    host.cylinderMesh.count = cursors.cylinderCount;
    host.beaconMesh.count = cursors.beaconCount;
    host.craneMastMesh.count = cursors.craneCount;
    host.decoCornerMesh.count = cursors.decoCursor;
    host.decoTrimMesh.count = cursors.decoCursor * 2;
    if (host.decoCornerMesh.instanceColor) host.decoCornerMesh.instanceColor.needsUpdate = true;
    if (host.decoTrimMesh.instanceColor) host.decoTrimMesh.instanceColor.needsUpdate = true;
    host.craneArmMesh.count = cursors.craneCount;
    // 霓虹载体（冠底带/牌框/色条）与 neonMesh 同一门控：非霓虹主题整体收起，物理件（鳍片/柱/板）常在。
    // 鳍片按实际片数收口——曾漏设 count（makeInstanced 初始为 0），城里所有酒店冠都不渲染。
    host.crownFinMesh.count = cursors.crownFinCursor;
    host.crownStripMesh.count = activeTheme().neon ? cursors.crownCursor : 0;
    if (host.crownStripMesh.instanceColor) host.crownStripMesh.instanceColor.needsUpdate = true;
    if (withRoadsideSigns) {
      host.buildRoadsideSigns(cursors.signCursor);
      // 路边牌占位后才知道四批次的实际用量：屋顶牌 0..signCursor-1，路边牌 signCursor..。
      host.signPostMesh.count = host.signPostCount * 2;
      host.signPanelMesh.count = host.signPostCount;
      host.signFrameMesh.count = activeTheme().neon ? host.signPostCount * 4 : 0;
      host.signStripeMesh.count = activeTheme().neon ? host.signPostCount * 3 : 0;
      if (host.signFrameMesh.instanceColor) host.signFrameMesh.instanceColor.needsUpdate = true;
      if (host.signStripeMesh.instanceColor) host.signStripeMesh.instanceColor.needsUpdate = true;
    }
}

export function buildRuntimes(host: BuildingSystemHost): void {
    const districtsById = new Map(host.layout.districts.map((district) => [district.id, district]));
    const cursors = emptyCursors(true);
    const ordered = [...host.model.buildings].sort((left, right) => left.startedAt - right.startedAt);
    for (const building of ordered) {
      const district = districtsById.get(building.districtId);
      const slot = district?.slots.get(building.id);
      if (!district || !slot) continue;
      placeRuntime(host, building, district, slot, cursors, false);
    }
    host.buildGroundSpill();
    // 天际线焦点：token 最多的会话。楼高本就是 token 的单调函数，它已是（或几乎是）最高楼；
    // 这里只给它专属冠顶，不改高度——高度是数据语义。
    let hero: BuildingRuntime | null = null;
    for (const runtime of host.runtimes) if (!hero || runtime.building.tokensTotal > hero.building.tokensTotal) hero = runtime;
    if (hero) {
      hero.hero = true;
      hero.roofKind = 0;
      host.buildHeroCrown(hero);
    }
    commitRuntimeCounts(host, cursors, true);

    // 初次落矩阵：回访的楼按已知高度写（settled），新到的楼从 display=0 藏起，
    // 由 update 循环长入——immediate=true 会按 target 写满高，新楼会先闪一下。
    for (const runtime of host.runtimes) host.applyConstruction(runtime, runtime.settled);
}

/** Place only buildings the current CityParts does not yet have. Existing instance indices stay put. */
export function appendRuntimes(host: BuildingSystemHost): BuildingRuntime[] {
    const districtsById = new Map(host.layout.districts.map((district) => [district.id, district]));
    const cursors = cursorsFromHost(host);
    const added: BuildingRuntime[] = [];
    const ordered = [...host.model.buildings].sort((left, right) => left.startedAt - right.startedAt);
    for (const building of ordered) {
      if (host.runtimeById.has(building.id)) continue;
      const district = districtsById.get(building.districtId);
      const slot = district?.slots.get(building.id);
      if (!district || !slot) continue;
      added.push(placeRuntime(host, building, district, slot, cursors, true));
    }
    if (!added.length) return added;
    commitRuntimeCounts(host, cursors, false);
    for (const runtime of added) host.applyConstruction(runtime, false);
    return added;
}

/**
 * 会话楼在地块背后还能加深多少（世界单位）：街区里两排地块背对背、中间留着一条空地（地块深 8，街区约 50×50，
 * 临街那排的地块中心离边 12，所以每排背后到街区中线还有 ~8 的空地，一直闲置）。
 * 沿地块进深轴（局部 +z = (sin yaw, cos yaw)）朝街区内部量：到街区中心留 0.8 的楼缝（对面那排也会加深，各让半条）、
 * 到街区边界留 3.5（路缘 + 人行道）。裁切出的单排街区靠第二条约束收住。海滨酒店 / Ocean Drive 地块不在 layout.blocks 里，恒 0。
 */
const roomCache = new WeakMap<object, Map<string, number>>();
function inwardRoom(layout: BuildingSystemHost["layout"], slot: { id: string; blockId: string; x: number; z: number; yaw: number; depth: number }): number {
  let byId = roomCache.get(layout);
  if (!byId) { byId = new Map(); roomCache.set(layout, byId); }
  const cached = byId.get(slot.id);
  if (cached !== undefined) return cached;
  const block = layout.blocks.find((candidate) => candidate.id === slot.blockId);
  let room = 0;
  if (block && block.polygon.length >= 3) {
    const ax = Math.sin(slot.yaw); const az = Math.cos(slot.yaw);
    const toCentre = (block.x - slot.x) * ax + (block.z - slot.z) * az;
    const sign = toCentre >= 0 ? 1 : -1;
    const dx = ax * sign; const dz = az * sign;
    let hit = Infinity;
    for (let i = 0; i < block.polygon.length; i += 1) {
      const a = block.polygon[i]; const b = block.polygon[(i + 1) % block.polygon.length];
      const ex = b.x - a.x; const ez = b.z - a.z;
      const denom = dx * ez - dz * ex;
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((a.x - slot.x) * ez - (a.z - slot.z) * ex) / denom;
      const u = ((a.x - slot.x) * dz - (a.z - slot.z) * dx) / denom;
      if (t > 0.01 && u >= 0 && u <= 1 && t < hit) hit = t;
    }
    room = Math.max(0, Math.min(Math.abs(toCentre) - 0.8, hit - 3.5) - slot.depth / 2);
    room = Math.min(room, 9);
  }
  byId.set(slot.id, room);
  return room;
}

export function applyConstruction(host: BuildingSystemHost, runtime: BuildingRuntime, immediate: boolean): void {
    const building = runtime.building;
    let { x, z } = runtime.slot;
    const g = runtime.groundY;
    const visible = immediate ? runtime.target : runtime.display;
    const fraction = Math.max(0, Math.min(1, visible));
    if (fraction <= 0.001) {
      host.hideAll(runtime);
      return;
    }
    const h = building.height;
    const fp = building.footprint;
    const built = Math.max(0.5, fraction * h);
    const split = host.formOf(building) === "tower" || host.formOf(building) === "landmark" ? 0.72 : 1;
    const podiumHeight = runtime.podium >= 0 ? Math.min(built, 1.5) : 0;

    let widths: [number, number];
    if (host.formOf(building) === "slab") widths = [fp * 1.3, fp * 0.58];
    else if (host.formOf(building) === "block") widths = [fp * 1.2, fp * 0.85];
    else if (host.formOf(building) === "tower" || host.formOf(building) === "landmark") widths = [fp * 0.72, fp * 0.72]; // 细方塔（曾 0.86×0.55，与板楼裁平后难分）
    else widths = [fp, fp];
    const streetWidth = runtime.slot.width * (runtime.slot.zone === "downtown" ? 0.8 : 0.88);
    if (host.formOf(building) !== "tower" && host.formOf(building) !== "landmark") widths[0] = Math.max(widths[0], streetWidth);
    widths[0] = Math.min(widths[0], runtime.slot.width - 0.8);
    widths[1] = Math.min(widths[1], runtime.slot.depth - 2);
    // 占地加粗（用户：「session building 现在太细了」）。塔身曾只有 fp·0.72 ≈ 3 m 见方、高 30–48 m（高宽比 10–16:1），
    // 板楼/中层深度只有 4–5。改为：面宽几乎铺满地块（7.2 − 0.8 = 6.4）、进深朝街区内部加深到背后的闲置空地
    // （inwardRoom，通常 +7～9），再按形态取比例；楼的临街一面位置不变（只往后长），不压别的地块。
    // 海滨酒店 / Ocean Drive 地块自有一套（下面覆盖）。
    let deepen = 0;
    if (!runtime.slot.blockId.startsWith("hotel:") && !runtime.slot.blockId.startsWith("oceandrive:")) {
      const form = host.formOf(building);
      const room = inwardRoom(host.layout, runtime.slot);
      const frontSetback = 0.5; // 楼前沿离地块前沿
      const depthRoom = runtime.slot.depth - 2 * frontSetback + room; // 临街到街区背后的可用进深
      const vary = 0.92 + building.seed * 0.08;
      const frontage = (runtime.slot.width - 0.8) * vary; // 并入相邻空地块的高楼 slot.width = 14.4 → 面宽 13.6
      const share = form === "tower" || form === "landmark" ? 0.66 : form === "slab" ? 0.82 : form === "block" ? 0.74 : 0.7;
      widths = [frontage, Math.max(widths[1], depthRoom * share)];
      deepen = (widths[1] / 2) - (runtime.slot.depth / 2 - frontSetback); // 前沿固定，中心沿内向轴后移
      if (deepen > 0) {
        const block = host.layout.blocks.find((candidate) => candidate.id === runtime.slot.blockId);
        const ax = Math.sin(runtime.slot.yaw); const az = Math.cos(runtime.slot.yaw);
        const sign = block && ((block.x - runtime.slot.x) * ax + (block.z - runtime.slot.z) * az) < 0 ? -1 : 1;
        x += ax * sign * deepen; z += az * sign * deepen;
      }
    }
    // 海滨酒店地块上的会话楼：铺满宽地块成为一栋酒店（低楼走装饰艺术立面，见 facadeFor 的海滨规则）。
    // 楼高仍由 token 决定——酒店是会话，不是装饰。
    if (runtime.slot.blockId.startsWith("hotel:")) widths = [runtime.slot.width * 0.92, runtime.slot.depth * 0.9];
    // Ocean Drive 街墙地块：会话楼铺满面宽（楼缝 1–2.5 由排地块时留），否则落成细塔，街墙读不出来（截图）。
    if (runtime.slot.blockId.startsWith("oceandrive:")) widths = [runtime.slot.width * 0.97, runtime.slot.depth * 0.92];

    // Parcel frontage owns orientation; podium, shaft and roof share it.
    const yaw = runtime.slot.yaw;
    // 主体段。
    const shaftBottom = g + podiumHeight;
    const shaftTop = g + Math.min(built, h * split);
    const shaftHeight = Math.max(0, shaftTop - shaftBottom);
    if (runtime.shaftPrimary >= 0) {
      if (shaftHeight < 0.15) {
        host.compose(x, -40, z, 0, 0, 0, 0);
      } else {
        host.compose(x, shaftBottom, z, yaw, widths[0], shaftHeight, widths[1]);
      }
      if (runtime.cylinder >= 0) {
        // 圆筒塔：圆柱取代方形主体与退台（直径取较短边 × 1.1），方楼实例藏起。
        const dia = Math.min(widths[0], widths[1]) * 1.1;
        host.compose(x, shaftBottom, z, yaw, dia, Math.max(0, g + built - shaftBottom), dia);
        host.cylinderMesh.setMatrixAt(runtime.cylinder, host.matrix);
        host.compose(x, -40, z, 0, 0, 0, 0);
      }
      host.shaftMeshes[runtime.facade].setMatrixAt(runtime.shaftPrimary, host.matrix);
    }
    // 退台段（tower/landmark）。
    if (runtime.shaftUpper >= 0) {
      const upperHeight = Math.max(0, built - h * split);
      if (upperHeight < 0.15) {
        host.compose(x, -40, z, 0, 0, 0, 0);
      } else {
        host.compose(x, g + h * split, z, yaw, widths[0] * 0.72, upperHeight, widths[1] * 0.72);
      }
      if (runtime.cylinder >= 0) host.compose(x, -40, z, 0, 0, 0, 0);
      host.shaftMeshes[runtime.facade].setMatrixAt(runtime.shaftUpper, host.matrix);
    }
    if (runtime.podium >= 0) {
      host.compose(x, g, z, yaw, Math.max(fp * 1.16, widths[0] * 1.06), podiumHeight > 0.1 ? podiumHeight : 0, Math.max(fp * 1.16, widths[1] * 1.06));
      host.podiumMesh.setMatrixAt(runtime.podium, host.matrix);
    }
    if (runtime.roof >= 0) {
      const roofY = g + Math.max(0.4, built - 0.18);
      const roofWidth = runtime.shaftUpper >= 0 && built > h * split ? widths[0] * 0.78 : widths[0] * 1.06;
      const roofDepth = runtime.shaftUpper >= 0 && built > h * split ? widths[1] * 0.78 : widths[1] * 1.06;
      host.compose(x, roofY, z, yaw, roofWidth, 0.34, roofDepth);
      host.roofMesh.setMatrixAt(runtime.roof, host.matrix);
      host.compose(x, roofY - 0.12, z, yaw, roofWidth * 1.16, 0.3, roofDepth * 1.16);
      host.neonMesh.setMatrixAt(runtime.roof, host.matrix);
      // 屋顶轮廓只在封顶后出现：施工中的楼顶是脚手架。
      const capped = fraction > 0.985;
      const top = roofY + 0.34;
      host.roofProfiles.forEach((mesh, index) => {
        const kind = index + 1;
        if (!capped || runtime.roofKind !== kind) host.compose(x, -40, z, 0, 0, 0, 0);
        else if (kind === 1) host.compose(x, top, z, yaw, roofWidth, Math.min(roofWidth, roofDepth) * 0.42, roofDepth);
        else if (kind === 2) host.compose(x, top, z, yaw, roofWidth * 0.92, Math.max(6, h * 0.22), roofDepth * 0.92);
        else if (kind === 3) host.compose(x, top, z, yaw, roofWidth * 0.62, Math.max(2.4, h * 0.06), roofDepth * 0.62);
        else host.compose(x, top, z, yaw, roofWidth * 0.86, 0.35, roofDepth * 0.86);
        mesh.setMatrixAt(runtime.roof, host.matrix);
      });
      for (let tree = 0; tree < 3; tree += 1) {
        if (capped && runtime.roofKind === 4) {
          const angle = runtime.building.seed * 6.283 + tree * 2.1;
          const reach = Math.min(roofWidth, roofDepth) * 0.28;
          const scale = 0.7 + ((runtime.building.seed * 7 + tree) % 1) * 0.5;
          host.compose(x + Math.cos(angle) * reach, top + 0.3, z + Math.sin(angle) * reach, 0, scale, scale * 1.1, scale);
        } else host.compose(x, -40, z, 0, 0, 0, 0);
        host.gardenTreeMesh.setMatrixAt(runtime.roof * 3 + tree, host.matrix);
      }
      if (runtime.hero) host.placeHeroCrown(x, roofY + 0.34, z, roofWidth, roofDepth, h, capped);
    }
    // 脚手架：包住"计划高度"的剩余部分——楼还没到的地方先看见壳。
    if (runtime.scaffold >= 0) {
      const remaining = h - built;
      if (fraction < 0.985 && remaining > 0.6) {
        host.compose(x, g + built, z, yaw, widths[0] * 1.14, remaining, widths[1] * 1.14);
      } else {
        host.compose(x, -40, z, 0, 0, 0, 0);
      }
      host.scaffoldMesh.setMatrixAt(runtime.scaffold, host.matrix);
    }
    // 装饰艺术附件：圆角转角柱随楼长高；封顶后立起阶梯女儿墙；底层有遮阳棚。
    if (runtime.deco >= 0) {
      const local = (lx: number, lz: number) => ({ x: x + lx * Math.cos(yaw) + lz * Math.sin(yaw), z: z - lx * Math.sin(yaw) + lz * Math.cos(yaw) });
      const radius = Math.min(widths[0], widths[1]) * 0.24;
      const corner = local(widths[0] / 2 - radius * 0.55, widths[1] / 2 - radius * 0.55);
      host.compose(corner.x, g, corner.z, 0, radius, Math.max(0.2, built + 0.4), radius);
      host.decoCornerMesh.setMatrixAt(runtime.deco, host.matrix);
      const done = fraction > 0.985;
      const crown = local(0, widths[1] * 0.1);
      host.compose(crown.x, g + built, crown.z, yaw, done ? widths[0] * 0.42 : 0, done ? 2.4 : 0, done ? widths[1] * 0.7 : 0);
      host.decoTrimMesh.setMatrixAt(runtime.deco * 2, host.matrix);
      const awning = local(-widths[0] * 0.08, widths[1] / 2 + 0.8);
      const awningOn = built > 3.4;
      host.compose(awning.x, g + 2.7, awning.z, yaw, awningOn ? widths[0] * 0.66 : 0, awningOn ? 0.28 : 0, awningOn ? 1.7 : 0);
      host.decoTrimMesh.setMatrixAt(runtime.deco * 2 + 1, host.matrix);
    }
    // 海滨酒店冠（L-1）：封顶才戴上。鳍片几何是箱心锚定（crownFinMesh 用了不带 translate 的
    // BoxGeometry），所以 y 直接写 fin.y；冠底霓虹带走底面锚定的 BOX，底边贴 stripY。
    if (runtime.crown && runtime.crownBase >= 0) {
      const capped = fraction > 0.985;
      const crownLocal = (lx: number, lz: number) => ({ x: x + lx * Math.cos(yaw) + lz * Math.sin(yaw), z: z - lx * Math.sin(yaw) + lz * Math.cos(yaw) });
      runtime.crown.fins.forEach((fin, index) => {
        if (!capped) host.compose(x, -40, z, 0, 0, 0, 0);
        else {
          const p = crownLocal(fin.x, fin.z);
          host.compose(p.x, g + fin.y, p.z, yaw, fin.sx, fin.sy, fin.sz);
        }
        host.crownFinMesh.setMatrixAt(runtime.crownBase + index, host.matrix);
      });
      if (!capped) host.compose(x, -40, z, 0, 0, 0, 0);
      else host.compose(x, g + runtime.crown.stripY, z, yaw, runtime.slot.width * 0.88, 0.28, runtime.slot.depth * 0.8);
      host.crownStripMesh.setMatrixAt(runtime.crownBase, host.matrix);
    }
    // 屋顶立牌（L-2）：封顶后立起；件 y 是屋顶面相对高度（建模期 roofY 传 0），世界 y = 地面 + 楼高。
    if (runtime.signPlan && runtime.signBase >= 0) {
      const capped = fraction > 0.985;
      const signY = g + h;
      const signLocal = (lx: number, lz: number) => ({ x: x + lx * Math.cos(yaw) + lz * Math.sin(yaw), z: z - lx * Math.sin(yaw) + lz * Math.cos(yaw) });
      const place = (pieces: Array<{ x: number; y: number; z: number; sx: number; sy: number; sz: number; rotY: number }>, mesh: THREE.InstancedMesh, stride: number) => {
        pieces.forEach((piece, index) => {
          if (!capped) host.compose(x, -40, z, 0, 0, 0, 0);
          else {
            const p = signLocal(piece.x, piece.z);
            host.compose(p.x, signY + piece.y, p.z, yaw + piece.rotY, piece.sx, piece.sy, piece.sz);
          }
          mesh.setMatrixAt(runtime.signBase * stride + index, host.matrix);
        });
      };
      place(runtime.signPlan.posts, host.signPostMesh, 2);
      place([runtime.signPlan.panel], host.signPanelMesh, 1);
      place(runtime.signPlan.frame, host.signFrameMesh, 4);
      place(runtime.signPlan.stripes, host.signStripeMesh, 3);
    }
    // 天线（landmark 封顶后立起）。
    if (runtime.antenna >= 0) {
      const done = fraction > 0.985;
      host.compose(x, g + h, z, 0, 1, done ? h * 0.1 + 3.4 : 0, 1);
      host.antennaMesh.setMatrixAt(runtime.antenna, host.matrix);
      host.compose(x, g + h + (done ? h * 0.1 + 3.4 : 0), z, 0, 1, 1, 1);
      host.beaconMesh.setMatrixAt(runtime.beacon >= 0 ? runtime.beacon : 0, host.matrix);
    }
    // 吊车（活跃会话）。
    if (runtime.craneMast >= 0) {
      const mastHeight = h * 1.02 + 6.5;
      // 立柱立在地块局部坐标的一角（随 slot.yaw 旋转），不再按世界轴偏移而被楼体吞掉。
      const localX = widths[0] * 0.5 + 0.6;
      const localZ = widths[1] * 0.5 + 0.6;
      const cornerX = x + localX * Math.cos(yaw) + localZ * Math.sin(yaw);
      const cornerZ = z - localX * Math.sin(yaw) + localZ * Math.cos(yaw);
      runtime.craneX = cornerX;
      runtime.craneZ = cornerZ;
      host.compose(cornerX, g, cornerZ, 0, 1, mastHeight, 1);
      host.craneMastMesh.setMatrixAt(runtime.craneMast, host.matrix);
      host.applyCraneArm(runtime, cornerX, cornerZ, g, mastHeight, 0);
    }
}

export function applyCraneArm(host: BuildingSystemHost, runtime: BuildingRuntime, cornerX: number, cornerZ: number, groundY: number, mastHeight: number, armRotation: number): void {
    const armLength = runtime.building.footprint * 2.4 + 3.4;
    const angle = runtime.cranePhase + armRotation;
    const centerX = cornerX + Math.cos(angle) * armLength * 0.34;
    const centerZ = cornerZ - Math.sin(angle) * armLength * 0.34;
    // three.js 绕 Y 转 θ 后 x 轴指向 (cosθ, -sinθ)，与上面的中心偏移同向，必须传 +angle；
    // 曾传 -angle，悬臂被镜像到另一侧，脱离立柱悬在空中。
    host.compose(centerX, groundY + mastHeight + 0.1, centerZ, angle, armLength, 2.2, 2.2);
    host.craneArmMesh.setMatrixAt(runtime.craneArm, host.matrix);
}

export function hideAll(host: BuildingSystemHost, runtime: BuildingRuntime): void {
    host.compose(0, -40, 0, 0, 0, 0, 0);
    const building = runtime.building;
    if (runtime.shaftPrimary >= 0) host.shaftMeshes[runtime.facade].setMatrixAt(runtime.shaftPrimary, host.matrix);
    if (runtime.shaftUpper >= 0) host.shaftMeshes[runtime.facade].setMatrixAt(runtime.shaftUpper, host.matrix);
    if (runtime.cylinder >= 0) host.cylinderMesh.setMatrixAt(runtime.cylinder, host.matrix);
    if (runtime.podium >= 0) host.podiumMesh.setMatrixAt(runtime.podium, host.matrix);
    if (runtime.deco >= 0) {
      host.decoCornerMesh.setMatrixAt(runtime.deco, host.matrix);
      host.decoTrimMesh.setMatrixAt(runtime.deco * 2, host.matrix);
      host.decoTrimMesh.setMatrixAt(runtime.deco * 2 + 1, host.matrix);
    }
    if (runtime.roof >= 0) {
      host.roofMesh.setMatrixAt(runtime.roof, host.matrix);
      host.neonMesh.setMatrixAt(runtime.roof, host.matrix);
      for (const mesh of host.roofProfiles) mesh.setMatrixAt(runtime.roof, host.matrix);
      for (let tree = 0; tree < 3; tree += 1) host.gardenTreeMesh.setMatrixAt(runtime.roof * 3 + tree, host.matrix);
      if (runtime.hero && host.heroParts) host.placeHeroCrown(0, -40, 0, 0, 0, 0, false);
    }
    if (runtime.scaffold >= 0) host.scaffoldMesh.setMatrixAt(runtime.scaffold, host.matrix);
    if (runtime.crown && runtime.crownBase >= 0) {
      for (let index = 0; index < runtime.crown.fins.length; index += 1) host.crownFinMesh.setMatrixAt(runtime.crownBase + index, host.matrix);
      host.crownStripMesh.setMatrixAt(runtime.crownBase, host.matrix);
    }
    if (runtime.signPlan && runtime.signBase >= 0) {
      for (let index = 0; index < 2; index += 1) host.signPostMesh.setMatrixAt(runtime.signBase * 2 + index, host.matrix);
      host.signPanelMesh.setMatrixAt(runtime.signBase, host.matrix);
      for (let index = 0; index < 4; index += 1) host.signFrameMesh.setMatrixAt(runtime.signBase * 4 + index, host.matrix);
      for (let index = 0; index < 3; index += 1) host.signStripeMesh.setMatrixAt(runtime.signBase * 3 + index, host.matrix);
    }
    if (runtime.antenna >= 0) host.antennaMesh.setMatrixAt(runtime.antenna, host.matrix);
    if (runtime.beacon >= 0) host.beaconMesh.setMatrixAt(runtime.beacon, host.matrix);
    if (runtime.craneMast >= 0) {
      host.craneMastMesh.setMatrixAt(runtime.craneMast, host.matrix);
      host.craneArmMesh.setMatrixAt(runtime.craneArm, host.matrix);
    }
}

export function roofKindFor(host: BuildingSystemHost, building: CityBuilding, facade: number): number {
    if (facade === 3) return 0; // 装饰艺术楼有自己的阶梯冠
    const zone = host.zoneById.get(building.id);
    const r = building.seed;
    if (host.formOf(building) === "landmark" || host.formOf(building) === "tower") return r > 0.66 ? 2 : r > 0.3 ? 3 : 0;
    if ((zone === "residential" || zone === "waterfront") && building.height < 30) return r < 0.55 ? 1 : 0;
    if (zone === "commercial") return r < 0.4 ? 4 : r < 0.6 ? 3 : 0;
    if (zone === "downtown") return r < 0.35 ? 3 : 0;
    return 0;
}

export function facadeFor(host: BuildingSystemHost, building: CityBuilding): number {
    const zone = host.zoneById.get(building.id);
    if (!zone) return building.facade;
    // 海滨（非地标、楼高 ≤ 36）→ 装饰艺术灰泥立面：粉彩墙、水平饰带、圆角转角。曾限定「低于 22」，
    // 但楼高由 token 决定，真实会话几乎都高于 22，一栋都没命中；迈阿密海滨的装饰艺术酒店本来也有十几层。
    // 楼高仍由 token 决定（数据语义不变），只是低矮的海滨楼换一种建筑语汇。
    if (zone === "waterfront" && building.height <= 36 && host.formOf(building) !== "landmark") return 3;
    // S5：地块只有 ~7 宽，体量差异被地块裁平（截图验收：同区仍千篇一律）。地价改由材质读出来——
    // 区内最贵的四分之一用玻璃幕墙（downtown 立面），最便宜的三成用住宅立面。
    const percentile = host.percentileOf(building);
    if (percentile !== undefined && percentile >= 0.75) return 2;
    if (percentile !== undefined && percentile < 0.3) return 0;
    if (zone === "downtown") return 2;
    if (zone === "commercial") return 1;
    if (zone === "residential") return 0;
    return building.seed > 0.5 ? 1 : 0;
}

export function percentileOf(host: BuildingSystemHost, building: CityBuilding): number | undefined {
    if (!host.landValueCache) host.formOf(building);
    return host.landValueCache?.get(building.id);
}

export function buildMassing(host: BuildingSystemHost): void {
    const blocks = host.layout.massing ?? [];
    if (!blocks.length) return;
    const mesh = host.makeInstanced(BOX, new THREE.MeshLambertMaterial({ color: "#c9c7bd" }), blocks.length);
    blocks.forEach((block, index) => {
      host.compose(block.x, block.y, block.z, hashSeed(`mass:${block.districtId}:${index}`) * 0.6 - 0.3, 16, block.height, 12);
      mesh.setMatrixAt(index, host.matrix);
      mesh.setColorAt(index, host.color.set(index % 2 ? "#c4c2b6" : "#cdcbbf"));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.name = "city-massing";
}

export function buildHeroCrown(host: BuildingSystemHost, hero: BuildingRuntime): void {
    const palette = paletteFor(hero.building.districtId);
    const spireMaterial = new THREE.MeshLambertMaterial({ color: "#dfe6ea", emissive: new THREE.Color(palette.accent).multiplyScalar(0.12) });
    const spire = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 8, 1).translate(0, 0.5, 0), spireMaterial);
    spire.castShadow = true;
    const ringMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(palette.accent).multiplyScalar(activeTheme().neon ? 3 : 1.4), toneMapped: false });
    const rings = [0, 1, 2].map(() => new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 6, 40).rotateX(Math.PI / 2), ringMaterial));
    let beam: THREE.Mesh | null = null;
    const disposables: Array<{ dispose(): void }> = [spire.geometry, spireMaterial, ringMaterial, ...rings.map((ring) => ring.geometry)];
    if (activeTheme().neon) {
      const beamMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(palette.accent).lerp(new THREE.Color("#ffffff"), 0.4).multiplyScalar(2.2), transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      // 光柱自下而上淡出（加色混合下顶点色 → 黑 = 透明）：曾是等亮度的 900 高圆柱，近看顶端是一截平切的白块。
      const beamGeometry = new THREE.CylinderGeometry(0.6, 1.6, 1, 16, 6, true).translate(0, 0.5, 0);
      const fade = new Float32Array(beamGeometry.attributes.position.count * 3);
      for (let i = 0; i < beamGeometry.attributes.position.count; i += 1) {
        const y = beamGeometry.attributes.position.getY(i);
        const k = Math.min(1, y / 0.03) * Math.pow(1 - y, 1.6); // 底部 ~12 单位淡入：近看不再是一截硬边白块
        fade[i * 3] = fade[i * 3 + 1] = fade[i * 3 + 2] = k;
      }
      beamGeometry.setAttribute("color", new THREE.BufferAttribute(fade, 3));
      beamMaterial.vertexColors = true;
      beamMaterial.visible = false; // 只在夜里亮（setNightGlow），白天天上不再挂一根白线
      beam = new THREE.Mesh(beamGeometry, beamMaterial);
      beam.renderOrder = 5;
      disposables.push(beam.geometry, beamMaterial);
      host.group.add(beam);
    }
    host.group.add(spire, ...rings);
    host.disposables.push(...disposables);
    host.heroParts = { spire, rings, beam };
}

export function placeHeroCrown(host: BuildingSystemHost, x: number, top: number, z: number, width: number, depth: number, h: number, capped: boolean): void {
    const parts = host.heroParts;
    if (!parts) return;
    const visible = capped;
    const radius = Math.min(width, depth) * 0.42;
    const spireHeight = Math.max(14, h * 0.4);
    parts.spire.visible = visible;
    parts.spire.position.set(x, top, z);
    parts.spire.scale.set(radius, spireHeight, radius);
    parts.rings.forEach((ring, index) => {
      ring.visible = visible;
      const t = 0.12 + index * 0.2;
      ring.position.set(x, top + spireHeight * t, z);
      const r = radius * (1 - t) + 0.6;
      ring.scale.set(r, 1, r);
    });
    if (parts.beam) {
      parts.beam.visible = visible;
      parts.beam.position.set(x, top + spireHeight, z);
      parts.beam.scale.set(1, 420, 1);
    }
}

export function buildRoadsideSigns(host: BuildingSystemHost, rooftopCount: number): void {
    // 按合并后的整条路取候选：路网被 T 路口切分、滨海路按 ~15 细分后，单条路段几乎没有 ≥60 的，
    // 曾因此一块牌都没立（实例全藏在 y=-40，建筑说明取景时发现）。整条路 ≥60 时取其最长一段的中点。
    const candidates = roadPaintPlan(host.layout.roadEdges ?? [])
      .runs.filter((run) => run.kind === "arterial" && atLeast(run, "collector"))
      .flatMap((run) => {
        let best: { a: Vec2; b: Vec2; len: number } | null = null; let total = 0;
        for (let i = 1; i < run.points.length; i += 1) {
          const a = run.points[i - 1]; const b = run.points[i]; const len = Math.hypot(b.x - a.x, b.z - a.z);
          total += len; if (!best || len > best.len) best = { a, b, len };
        }
        return best && total >= 60 && best.len >= 14 ? [{ edge: { width: run.width }, a: best.a, b: best.b, total }] : [];
      })
      .sort((p, q) => q.total - p.total);
    // 宿主边自己距牌位 ≥ 10（width/2+6），closerThan(7) 命中的只会是路口和邻路。
    const otherRoads = new SegmentIndex((host.layout.roadEdges ?? []).map((edge) => [edge.points[0], edge.points[edge.points.length - 1]]));
    const placed: Vec2[] = [];
    let cursor = rooftopCount;
    for (const { edge, a, b } of candidates) {
      if (cursor >= 32 || placed.length >= 8) break;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const normal = { x: -(b.z - a.z) / len, z: (b.x - a.x) / len };
      const pos = { x: mid.x + normal.x * (edge.width / 2 + 6), z: mid.z + normal.z * (edge.width / 2 + 6) };
      const groundY = host.layout.terrain.height(pos.x, pos.z);
      if (groundY < 0.5) continue; // 水面/桥上不立牌
      if (otherRoads.closerThan(pos, 7)) continue;
      if (placed.some((p) => Math.hypot(p.x - pos.x, p.z - pos.z) < 140)) continue;
      // 面板法线（局部 +Z）朝道路法向：牌面平行道路，双向车流都读到（模块两面同构图）。
      const yaw = Math.atan2(normal.x, normal.z);
      const plan = roadsideSignPlan(yaw, groundY, hashSeed(`roadsign:${pos.x.toFixed(1)}:${pos.z.toFixed(1)}`));
      const place = (pieces: Array<{ x: number; y: number; z: number; sx: number; sy: number; sz: number; rotY: number }>, mesh: THREE.InstancedMesh, stride: number) => {
        // 件的 x/z 是牌的局部偏移（未旋转）：按 compose 约定（局部 x = (cos, −sin)，局部 z = (sin, cos)）旋转后加上牌位。
        // 曾直接当世界坐标写——全城路边牌都叠在原点附近，路边一块都看不到（建筑说明取景时发现）。
        const c = Math.cos(yaw); const sn = Math.sin(yaw);
        pieces.forEach((piece, index) => {
          const wx = pos.x + piece.x * c + piece.z * sn; const wz = pos.z - piece.x * sn + piece.z * c;
          host.compose(wx, piece.y, wz, piece.rotY, piece.sx, piece.sy, piece.sz);
          mesh.setMatrixAt(cursor * stride + index, host.matrix);
        });
      };
      place(plan.pieces.slice(0, 2), host.signPostMesh, 2);
      place([plan.pieces[2]], host.signPanelMesh, 1);
      place(plan.frame, host.signFrameMesh, 4);
      place(plan.stripes, host.signStripeMesh, 3);
      // 路边牌不属于任何执行环境城区，框/条用主题外的中性 Vice 色板（与街区霓虹不抢色相）。
      plan.frame.forEach((_, k) => host.signFrameMesh.setColorAt(cursor * 4 + k, new THREE.Color("#38e8ff").multiplyScalar(3.2)));
      plan.stripes.forEach((_, k) => host.signStripeMesh.setColorAt(cursor * 3 + k, new THREE.Color(k % 2 ? "#ff4fd8" : "#ffd166").multiplyScalar(2.4)));
      placed.push(pos);
      cursor += 1;
    }
    host.signPostCount = cursor;
}

export function buildAnomalyMarkers(host: BuildingSystemHost): void {
    for (const district of host.layout.districts) {
      if (!district.anomaly) continue;
      const color = district.anomaly.severity === "critical" ? "#d64545" : district.anomaly.severity === "warning" ? "#e0940f" : "#4a7fa0";
      const geometry = new THREE.OctahedronGeometry(1.15);
      const material = new THREE.MeshBasicMaterial({ color });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(district.plaza.x, district.plaza.y + 9, district.plaza.z);
      mesh.renderOrder = 2;
      const ringGeometry = new THREE.RingGeometry(2.6, 3.0, 44).rotateX(-Math.PI / 2);
      const ringMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false });
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.position.set(district.plaza.x, district.plaza.y + 0.16, district.plaza.z);
      ring.renderOrder = 3;
      host.group.add(mesh, ring);
      host.anomalyMarkers.push({ mesh, ring, baseY: district.plaza.y + 9, phase: hashSeed(`anom:${district.id}`) * Math.PI * 2 });
      host.disposables.push(geometry, material, ringGeometry, ringMaterial);
    }
}

export function buildUrbanContext(host: BuildingSystemHost): void {
    const buildings = host.layout.contextBuildings ?? [];
    if (!buildings.length) return;
    const facade = makeDecoFacadeTexture();
    facade.colorSpace = THREE.SRGBColorSpace;
    facade.repeat.set(8, 5.5); // one facade tile per chamfered face; 2-floor tile × 5.5 gives ~11-floor rhythm.
    const bodyGeometry = artDecoTowerGeometry();
    const bodyMaterial = new THREE.MeshLambertMaterial({ map: facade });
    const bodies = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, buildings.length);
    const crownGeometry = BOX.clone();
    const crownMaterial = new THREE.MeshLambertMaterial({ color: "#f4e5d3" });
    const crowns = new THREE.InstancedMesh(crownGeometry, crownMaterial, buildings.length);
    const colorsByZone: Record<string, string[]> = {
      downtown: ["#91c8cf", "#d89bb6", "#b4a4d5", "#dfc49a"],
      commercial: ["#a8c9bf", "#d9ad9e", "#c5b9a2", "#9dbdcc"],
      waterfront: ["#e6c6a9", "#e5a8ad", "#b1d3cd", "#ead6b9"],
      residential: ["#c8c2a9", "#b5c3b0", "#d5bfa9", "#b8c3c5"],
    };
    for (let index = 0; index < buildings.length; index += 1) {
      const building = buildings[index];
      const colors = colorsByZone[building.zone] ?? colorsByZone.commercial;
      host.compose(building.x, building.y, building.z, building.yaw, building.width, building.height, building.depth);
      bodies.setMatrixAt(index, host.matrix);
      // F3：降饱和、略压明度——远看仍是统一天际线，近看一眼分出「我的楼」（会话楼保持执行环境色相与屋顶霓虹）。
      host.color.set(colors[Math.floor(building.seed * colors.length) % colors.length]);
      host.color.getHSL(host.hsl);
      bodies.setColorAt(index, host.color.setHSL(host.hsl.h, host.hsl.s * 0.45, host.hsl.l * 0.92));
      const roofScale = building.zone === "residential" ? 0.88 : 0.68;
      host.compose(building.x, building.y + building.height, building.z, building.yaw, building.width * roofScale, 1.2 + building.seed * 2.1, building.depth * roofScale);
      crowns.setMatrixAt(index, host.matrix);
      crowns.setColorAt(index, host.color.set(building.zone === "downtown"
        ? colors[(Math.floor(building.seed * colors.length) + 1) % colors.length]
        : colors[Math.floor(building.seed * colors.length) % colors.length]).multiplyScalar(building.zone === "residential" ? 0.9 : 1.05));
    }
    for (const mesh of [bodies, crowns]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    }
    bodies.name = "city-vice-context-facades";
    crowns.name = "city-vice-context-rooftops";
    // F2：记下每栋的完整矩阵（落成态），回放时按进度在 y 方向缩放写回。
    const matrices = new Float32Array(buildings.length * 32);
    for (let index = 0; index < buildings.length; index += 1) {
      bodies.getMatrixAt(index, host.matrix); host.matrix.toArray(matrices, index * 32);
      crowns.getMatrixAt(index, host.matrix); host.matrix.toArray(matrices, index * 32 + 16);
    }
    host.context = { bodies, crowns, matrices };
    host.group.add(bodies, crowns);
    host.disposables.push(bodyGeometry, bodyMaterial, facade, crownGeometry, crownMaterial);
}

export function updateContext(host: BuildingSystemHost, dt: number): void {
    let dirty = false;
    for (let index = 0; index < host.contextTarget.length; index += 1) {
      const current = host.contextProgress[index];
      const target = host.contextTarget[index];
      if (current === target) continue;
      host.contextProgress[index] = target > current ? Math.min(target, current + dt / 1.2) : Math.max(target, current - dt / 0.6);
      dirty = true;
    }
    if (dirty) host.writeContext();
}

export function writeContext(host: BuildingSystemHost): void {
    const context = host.context;
    if (!context) return;
    const count = Math.min(host.contextProgress.length, context.bodies.count);
    for (let index = 0; index < count; index += 1) {
      const t = host.contextProgress[index];
      const ease = t * t * (3 - 2 * t);
      for (const [mesh, offset] of [[context.bodies, 0], [context.crowns, 16]] as const) {
        host.contextScratch.fromArray(context.matrices, index * 32 + offset);
        // 屋顶冠在楼顶：楼还在长时先藏起（就地缩放会悬在半空），封顶后再出现。
        if (ease <= 0.001 || (offset === 16 && ease < 0.999)) host.contextScratch.makeScale(0, 0, 0).setPosition(0, -40, 0);
        else if (ease < 0.999) host.contextScratch.multiply(host.contextScale.makeScale(1, ease, 1));
        mesh.setMatrixAt(index, host.contextScratch);
      }
    }
    context.bodies.instanceMatrix.needsUpdate = true;
    context.crowns.instanceMatrix.needsUpdate = true;
}
