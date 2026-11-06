import * as THREE from "three";
import type { LandmarkCtx } from "../../models/landmarkContext";
import { LIGHT_BUDGET } from "../../cityLightBudget";
import { bridgeDeckProfile, bridgeDrivableHalf } from "../../surface/structureCompiler";

/** 地标「suspension-bridge」的程序化造型（从 cityParts.buildLandmarks 的 if 链原样搬出，行为不变）。 */
export function drawSuspensionBridge({ group, landmark, mesh, material, steel, neon, host }: LandmarkCtx): void {
  if (!landmark.to) return;
  // 悬索桥：沿既有过河桥加两座门式塔与主缆、吊索（路网不变，只是换造型）。
  // 曾把主缆写成整段抛物线并且塔底/吊索底硬编码在 y=0/8.2：塔外侧 |local|>1 时抛物线反向上翘，
  // 两侧缆索飞到塔顶之上（用户截图「两边桥上天了」）——主缆现在只在两塔之间是悬链，塔外是落到桥面的斜拉后锚。
  group.position.set(landmark.x, 0, landmark.z);
  group.rotation.y = -Math.atan2(landmark.to.z - landmark.z, landmark.to.x - landmark.x);
  const span = Math.hypot(landmark.to.x - landmark.x, landmark.to.z - landmark.z);
  // 塔、主缆、吊索、护栏灯都要落在可驶宽度之外。曾固定在 ±5.5（灯 ±5.2），而 12 宽桥面的可驶半宽是 5.7：
  // 碰撞把整根主缆取成保守包围盒（全跨 × 横向 5.2–5.8、离桥面约 0.7 起），0/7 出生路线开到桥头转弯时
  // 车顶扫进这条盒子，停在终点前 3.6（rendered:landmark:6）。现按实际桥面宽度放：缆与吊索贴桥面外缘外 0.15，
  // 塔身内侧面正好在桥面外缘，护栏灯在外缘（护栏所在处）。
  const deckEdge = (host.layout.roadEdges ?? []).find((e) => e.bridge && e.points.length >= 2 &&
    [[e.points[0], e.points[e.points.length - 1]], [e.points[e.points.length - 1], e.points[0]]].some(([a, b]) =>
      Math.hypot(a.x - landmark.x, a.z - landmark.z) < 2 && Math.hypot(b.x - landmark.to!.x, b.z - landmark.to!.z) < 2));
  const halfWidth = deckEdge ? Math.max(deckEdge.width / 2, bridgeDrivableHalf(deckEdge) + 0.05) : 6;
  const cableOff = halfWidth + 0.15; const towerOff = halfWidth + 0.8; const lampOff = halfWidth;
  // 桥面随引道起伏（与 buildInfrastructure 同一条 bridgeDeckProfile）：塔、主缆、吊索都以它为底。
  // Unlanded ends keep the old level deck, including its 0.3 floor above the water.
  const profile = bridgeDeckProfile(host.layout, landmark, landmark.to, 0, 0.3);
  const deckAt = (x: number) => profile.at(Math.min(1, Math.max(0, x / Math.max(1e-6, span))));
  const towerH = 34;
  const t0 = span * 0.18;
  const t1 = span * 0.82;
  const mid = (t0 + t1) / 2;
  const top0 = deckAt(t0) + towerH - 1; const top1 = deckAt(t1) + towerH - 1;
  const sag = towerH - 1 - 9; // 主缆垂度：原「塔顶 − (桥面 + 9)」
  const towerMaterial = material("#c8473a");
  for (const x of [t0, t1]) {
    for (const side of [-1, 1]) mesh(new THREE.BoxGeometry(1.6, towerH, 1.6).translate(0, towerH / 2, 0), towerMaterial, group, x, deckAt(x), side * towerOff);
    mesh(new THREE.BoxGeometry(1.6, 1.6, 2 * towerOff + 1.6).translate(0, 0.8, 0), towerMaterial, group, x, deckAt(x) + towerH - 4, 0);
  }
  const lights = host.nightLights;
  const bulbs: Array<[number, number, number, number]> = []; // x,y,z,kind(0 = 暖灯, 1 = 霓虹)
  // 后锚落点离桥面 BACKSTAY_LIFT（曾为 1：桥头转弯的车顶扫过它）。缆管半径 0.3，管底在桥面以上 2.7，高于车顶。
  const BACKSTAY_LIFT = 3;
  const cableY = (x: number) => {
    if (x < t0) return deckAt(0) + BACKSTAY_LIFT + (x / Math.max(1, t0)) * (top0 - deckAt(0) - BACKSTAY_LIFT);
    if (x > t1) return deckAt(span) + BACKSTAY_LIFT + ((span - x) / Math.max(1, span - t1)) * (top1 - deckAt(span) - BACKSTAY_LIFT);
    const c = (x - mid) / ((t1 - t0) / 2);
    const top = top0 + (top1 - top0) * (x - t0) / (t1 - t0);
    return top - sag * (1 - c * c);
  };
  for (const side of [-1, 1]) {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 40; i += 1) {
      const x = (i / 40) * span;
      points.push(new THREE.Vector3(x, cableY(x), side * cableOff));
    }
    // 分 8 段建：碰撞按每个网格取保守包围盒，整根缆一个盒子会把最低点（后锚）的高度铺满整座桥。
    for (let k = 0; k < 40; k += 5) {
      const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.slice(k, k + 6)), 8, 0.3, 5), steel);
      host.disposables.push(cable.geometry);
      group.add(cable);
    }
    // 吊索：只在两塔之间，从桥面立起到主缆。
    for (let x = t0 + 3; x < t1 - 2; x += 4) {
      const y = cableY(x);
      const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.12, y - deckAt(x) - 0.9, 0.12).translate(0, (y - deckAt(x) - 0.9) / 2, 0), steel);
      hanger.position.set(x, deckAt(x) + 0.9, side * cableOff);
      host.disposables.push(hanger.geometry);
      group.add(hanger);
      bulbs.push([x, y - 0.5, side * cableOff, 0]);
    }
    // 桥面护栏灯串与塔身霓虹。
    for (let x = 4; x < span - 3; x += 7) bulbs.push([x, deckAt(x) + 1.1, side * lampOff, 0]);
    for (const tx of [t0, t1]) {
      bulbs.push([tx, deckAt(tx) + towerH + 0.4, side * towerOff, 1]);
      for (let k = 1; k <= 4; k += 1) bulbs.push([tx, deckAt(tx) + (towerH * k) / 5, side * towerOff + side * 0.9, 1]);
    }
  }
  if (lights && bulbs.length) {
    const place = (list: typeof bulbs, material: THREE.Material, size: number, neonTint: boolean) => {
      if (!list.length) return;
      const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(size, size, size), material, list.length);
      list.forEach((b, i) => {
        host.matrix.compose(host.positionVector.set(b[0], b[1], b[2]), host.quaternion.identity(), host.scaleVector.set(1, 1, 1));
        instanced.setMatrixAt(i, host.matrix);
        if (neonTint) instanced.setColorAt(i, host.color.set(i % 2 === 0 ? "#38e8ff" : "#ff4fd8").lerp(host.spillWhite.set("#fff1dc"), 1 - LIGHT_BUDGET.neon.bridgeSaturation)); // N4：桥塔霓虹降饱和
      });
      instanced.instanceMatrix.needsUpdate = true;
      if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
      instanced.frustumCulled = false;
      host.disposables.push(instanced.geometry);
      group.add(instanced);
    };
    place(bulbs.filter((b) => b[3] === 0), lights.heads, 0.5, false);
    place(bulbs.filter((b) => b[3] === 1), lights.neon, 0.9, true);
  }
}
