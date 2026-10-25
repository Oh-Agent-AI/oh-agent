/**
 * L-4 机场岛 + L-5 多跨堤道桥（CITY_LANDMARK_BACKLOG）：主岛外浅水区一座填海平台（跑道、壳形航站楼、塔台、
 * 登机桥指廊），由一条低矮的多跨堤道（薄板桥面 + 等距排架墩 + 护栏）与主岛相连。纯程序化原创几何，
 * 不参照任何具体机场；装饰，不进路网、不代表会话。选址：避开海滨景观段与港口方位的那段海岸，向外 140。
 */
import * as THREE from "three";
import type { Vec2 } from "./cityLayout";
import { parkedMechaSquad, parkedPlane } from "./render/playableVehicles";

export { AIRPORT_PLATFORM, airportCausewayEnd, planAirport, roadSamples, type AirportPlan } from "./airportPlan";
import { AIRPORT_PLATFORM, type AirportPlan } from "./airportPlan";

/** 生成机场岛网格组（单一 Group，名字以 city-landmark-airport 开头供拾取）。堤道是路网里的一段桥面
 *  （cityLayout 加进 roadEdges，普通桥梁渲染器画桥面 / 护栏 / 桥墩），这里只画岛。
 *  跑道、滑行道、标线是贴在平台顶面的薄层（标记 cityDrivingNonSolid）：平台是可行驶的地标平台，车从上面开过。 */
export function buildAirport(plan: AirportPlan, disposables: Array<{ dispose: () => void }>, nightHead: THREE.Material | null,
  planeScaleDiagonal?: number): THREE.Group {
  const group = new THREE.Group();
  group.name = "city-landmark-airport";
  const mat = (color: string) => { const m = new THREE.MeshLambertMaterial({ color }); disposables.push(m); return m; };
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, ry = 0, parent: THREE.Object3D = island) => {
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); mesh.rotation.y = ry;
    mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); disposables.push(geometry); return mesh;
  };
  // 机场岛：局部坐标，z 轴 = 离岸方向，跑道沿 x（与海岸平行）。
  const island = new THREE.Group();
  island.position.set(plan.centre.x, 0, plan.centre.z);
  island.rotation.y = plan.yaw;
  group.add(island);
  const L = AIRPORT_PLATFORM.length; const W = AIRPORT_PLATFORM.width; const TOP = AIRPORT_PLATFORM.top;
  // 平台顶面 = TOP（曾是 0.4，而跑道 / 航站楼 / 塔台底都在 1.4：整组悬空 1）。
  add(new THREE.BoxGeometry(L, TOP + 2, W).translate(0, (TOP + 2) / 2, 0), mat("#cfc9b8"), 0, -2, 0);  // 填海平台（−2 … TOP）
  add(new THREE.BoxGeometry(L + 6, 0.8, W + 6).translate(0, 0.4, 0), mat("#9c968a"), 0, -1.4, 0);        // 护岸石
  const flat = (mesh: THREE.Mesh) => { mesh.userData.cityDrivingNonSolid = true; return mesh; }; // 贴面薄层：车从上面开过
  flat(add(new THREE.BoxGeometry(L - 20, 0.02, 22).translate(0, 0.01, 0), mat("#3e4448"), 0, TOP, -18));        // 跑道
  for (let x = -L / 2 + 22; x < L / 2 - 22; x += 12) flat(add(new THREE.BoxGeometry(6, 0.01, 0.6), mat("#f2f0e6"), x, TOP + 0.025, -18));  // 中线
  for (const side of [-1, 1]) for (let k = 0; k < 6; k += 1) flat(add(new THREE.BoxGeometry(0.6, 0.01, 14), mat("#f2f0e6"), side * (L / 2 - 16 - k * 1.6), TOP + 0.025, -18)); // 端头斑马线
  flat(add(new THREE.BoxGeometry(L - 40, 0.015, 10).translate(0, 0.0075, 0), mat("#565c60"), 0, TOP, 4));     // 滑行道
  // 壳形航站楼：沿弧排列的褶皱壳片。
  const shell = mat("#f4f6f2");
  for (let k = 0; k < 7; k += 1) {
    const piece = add(new THREE.CylinderGeometry(9, 9, 10, 16, 1, true, 0, Math.PI).rotateZ(Math.PI / 2), shell, -36 + k * 12, 6, 30);
    (piece.material as THREE.MeshLambertMaterial).side = THREE.DoubleSide;
  }
  add(new THREE.BoxGeometry(86, 6, 18).translate(0, 3, 0), mat("#4f6b78"), 0, 1.4, 30);                 // 玻璃立面
  for (const x of [-30, 0, 30]) {                                                                         // 登机桥指廊
    const bridge = add(new THREE.BoxGeometry(3, 3, 16).translate(0, 1.5, -8), mat("#dfe3e0"), x, 3, 21);
    bridge.rotation.x = 0.05;
  }
  // 塔台：细身 + 悬挑玻璃顶舱 + 红灯。
  add(new THREE.CylinderGeometry(1.6, 2.2, 30, 10).translate(0, 15, 0), mat("#e2ddd2"), 80, 1.4, 34);
  add(new THREE.CylinderGeometry(5, 4, 4.5, 10).translate(0, 2.25, 0), mat("#3f5f6e"), 80, 31.4, 34);
  add(new THREE.CylinderGeometry(5.4, 5.4, 0.6, 10), mat("#e2ddd2"), 80, 36.2, 34);
  add(new THREE.SphereGeometry(0.7, 8, 6), nightHead ?? mat("#ff3b3b"), 80, 37.2, 34);
  // 机坪上停着一架可以开的飞机（2026-10-22，用户：「把飞机游戏的建模放到机场，用户点击以后可以开始玩开飞机」）：
  // 滑行道与航站楼之间、指廊西侧，机头顺跑道；落在平台顶面（TOP）上。机场岛是驾驶地标根，停着的飞机开车时也是障碍物。点它从跑道西端顺跑道方向起飞（runway 标记点给出世界位姿，CityEngine.playableAt）。
  if (planeScaleDiagonal !== undefined) {
    const plane = parkedPlane(planeScaleDiagonal, disposables);
    plane.position.set(-62, TOP, 14);
    island.add(plane);
    const runway = new THREE.Object3D(); runway.name = "city-playable-plane-runway";
    runway.position.set(-L / 2 + 30, TOP, -18);
    island.add(runway);
    plane.userData.runway = runway;
    // 三台机甲停在机坪东侧、滑行道和航站楼之间，面朝跑道。点任何一台进入机甲战棋。
    // 机场岛是驾驶地标根，它们开车时也是障碍。避开跑道西端（飞机起飞点）和航站楼中轴。
    const squad = parkedMechaSquad(disposables);
    squad.position.set(40, TOP, 14);
    island.add(squad);
  }
  // 跑道边灯（夜间与路灯同批次材质，白天不亮）。
  if (nightHead) for (let x = -L / 2 + 14; x <= L / 2 - 14; x += 14) for (const z of [-30, -6]) add(new THREE.BoxGeometry(0.6, 0.4, 0.6), nightHead, x, 1.6, z);
  return group;
}
