/**
 * 城里「点一下就能开」的载具（2026-10-22，用户：「把飞机游戏的建模放到机场，用户点击以后可以开始玩开飞机；
 * 每个城区地标楼下面的停车场可以放汽车模型，点击以后进入开车模式，出发点就是这个地标楼，车的颜色按城区 harness 楼的配色」）。
 *
 * 造型直接用游戏里那一份（CarVisuals / FlightVisuals）——停着的就是你要开的那辆，不另画一个长得不一样的替身。
 * 模型组按名字认领：`city-playable-car:<districtId>`、`city-playable-plane`、`city-playable-mecha`，
 * 拾取（uiOverlays.decorAt）据此给出 `play:car:<districtId>` / `play:plane` / `play:mecha`，
 * 引擎点击时把世界位姿交给宿主去开游戏（CityEngine.playableAt）。
 * 只做静态摆放：不随帧更新、不挂灯（FlightVisuals 自带的闪光点光源关掉——多一盏灯会让全城材质重编译、场景基线也跟着变）。
 */
import * as THREE from "three";
import { CarVisuals } from "../../game/CarVisuals";
import { FlightVisuals } from "../../game/FlightVisuals";
import { flightParamsFor } from "../../game/FlightSimulation";
import { createAssault, createGunner, createSupport, disposeMechaModel } from "../../game/mecha/models";
import { VISUAL_BOOST } from "../worldScale";

export const PLAYABLE_CAR_PREFIX = "city-playable-car:";
export const PLAYABLE_PLANE_NAME = "city-playable-plane";
export const PLAYABLE_MECHA_NAME = "city-playable-mecha";
/** 停着的车、飞机、机甲的缩放登记在 worldScale.VISUAL_BOOST；开起来的车和飞机仍是游戏里那一份原尺寸。机甲停着和开战用同一个倍数。 */
const PARKED_CAR_SCALE = VISUAL_BOOST.parkedCar;
const PARKED_PLANE_SCALE = VISUAL_BOOST.parkedPlane;
const PARKED_MECHA_SCALE = VISUAL_BOOST.parkedMecha;

/** 一辆停着的车：车头朝局部 +z（地标场地的「朝街」方向），城区配色。 */
export function parkedCar(districtId: string, color: string, disposables: Array<{ dispose: () => void }>): THREE.Group {
  const group = new THREE.Group();
  group.name = `${PLAYABLE_CAR_PREFIX}${districtId}`;
  const car = new CarVisuals(color);
  car.update({ x: 0, y: 0, z: 0, heading: Math.PI / 2, pitch: 0, roll: 0, steering: 0, distance: 0, braking: false, reversing: false });
  car.root.scale.setScalar(PARKED_CAR_SCALE);
  car.root.traverse((node) => { if ((node as THREE.Mesh).isMesh) { node.castShadow = true; node.receiveShadow = true; } });
  group.add(car.root);
  disposables.push({ dispose: () => car.dispose() });
  return group;
}

/** 一架停在机坪上的飞机：机头朝局部 +x（与跑道平行），机轮落在 group 原点的高度上。diagonal = 城区对角线（与飞行游戏同一份尺度）。 */
export function parkedPlane(diagonal: number, disposables: Array<{ dispose: () => void }>): THREE.Group {
  const group = new THREE.Group();
  group.name = PLAYABLE_PLANE_NAME;
  const plane = new FlightVisuals(flightParamsFor(diagonal));
  plane.group.traverse((node) => {
    if ((node as THREE.Light).isLight) node.visible = false;
    if ((node as THREE.Mesh).isMesh) { node.castShadow = true; node.receiveShadow = true; }
  });
  plane.group.scale.setScalar(PARKED_PLANE_SCALE);
  plane.group.updateMatrixWorld(true);
  const bottom = new THREE.Box3().setFromObject(plane.group).min.y;
  plane.group.position.y = Number.isFinite(bottom) ? -bottom : 0;
  group.add(plane.group);
  disposables.push({ dispose: () => plane.dispose() });
  return group;
}

/** 三台玩家机甲并排停在机坪上。脚在组原点，面朝局部 −Z（和战棋模型一致）。点任何一台都进同一场战斗。 */
export function parkedMechaSquad(disposables: Array<{ dispose: () => void }>): THREE.Group {
  const group = new THREE.Group();
  group.name = PLAYABLE_MECHA_NAME;
  const spacing = 22;
  for (const [index, make] of [createAssault, createGunner, createSupport].entries()) {
    const mech = make();
    mech.scale.setScalar(PARKED_MECHA_SCALE);
    mech.position.set((index - 1) * spacing, 0, 0);
    mech.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) { node.castShadow = true; node.receiveShadow = true; }
    });
    group.add(mech);
    disposables.push({ dispose: () => disposeMechaModel(mech) });
  }
  return group;
}

export type PlayTarget =
  | { kind: "car"; districtId: string; color: string; x: number; z: number; heading: number }
  | { kind: "plane"; x: number; y: number; z: number; heading: number }
  | { kind: "mecha" };

/** 拾取 id → 载具种类（不是载具 id 时为 null）。 */
export function playableKind(id: string | null | undefined): "car" | "plane" | "mecha" | null {
  if (!id) return null;
  if (id === "play:plane") return "plane";
  if (id === "play:mecha") return "mecha";
  return id.startsWith("play:car:") ? "car" : null;
}
