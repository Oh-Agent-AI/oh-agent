import * as THREE from "three";
import type { LandmarkCtx } from "../../models/landmarkContext";
import { createRenderCanvas } from "../../renderCanvas";
import { hashSeed } from "../../../cityModel";

/** 地标「twin-towers」的程序化造型（从 cityParts.buildLandmarks 的 if 链原样搬出，行为不变）。 */
export function drawTwinTowers({ group, mesh, material, white, steel, cap, neon, host }: LandmarkCtx): void {
  // Miami Tropical Deco 双塔：白色塔身 + 浅青玻璃带窗、每层带一道白色「眉檐」遮阳板、四角粉彩竖鳍、
  // 阶梯式（ziggurat）塔冠与霓虹勾边。曾用夜景窗格贴图乘粉彩色：贴图本身偏暗，乘出来两栋漆黑（真机截图）。
  const h = Math.min(cap, 62);
  const canvas = createRenderCanvas(); canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#f6f3ec"; ctx.fillRect(0, 0, 64, 64);              // 白色外墙
    ctx.fillStyle = "#8fd3dc"; ctx.fillRect(4, 18, 56, 30);             // 带窗（浅青玻璃）
    ctx.fillStyle = "#b9e6ec"; ctx.fillRect(4, 18, 56, 6);              // 玻璃上沿反光
    ctx.fillStyle = "#e9e4da"; for (let x = 4; x < 64; x += 14) ctx.fillRect(x, 18, 2, 30); // 窗棂
  }
  const facade = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  facade.colorSpace = THREE.SRGBColorSpace;
  facade.wrapS = facade.wrapT = THREE.RepeatWrapping;
  const floors = Math.max(8, Math.round(h / 4));
  facade.repeat.set(3, floors);
  // 少量自发光托底：暖色夕照下纯 Lambert 白墙读成米褐色（截图实测），粉彩鳍读成暗红/墨绿。
  const wall = new THREE.MeshLambertMaterial({ map: facade, emissive: new THREE.Color("#3a3936"), emissiveMap: facade });
  // 夜景亮窗：玻璃幕墙夜里要开灯（真机夜景：双塔窗格全暗）。一张 4 层高的亮窗图（黑墙 + 暖色窗格，
  // 随机约 30% 熄灯），按层平铺；setNightGlow 在夜里把 emissiveMap 换成它并按夜色加亮。
  const litCanvas = createRenderCanvas(); litCanvas.width = 64; litCanvas.height = 256;
  const lctx = litCanvas.getContext("2d");
  if (lctx) {
    lctx.fillStyle = "#000000"; lctx.fillRect(0, 0, 64, 256);
    for (let floor = 0; floor < 4; floor += 1) for (let cell = 0; cell < 4; cell += 1) {
      const on = hashSeed(`twin-window:${floor}:${cell}`);
      if (on < 0.3) continue;
      lctx.fillStyle = on > 0.85 ? "#bfe9ff" : "#ffd89a";
      lctx.fillRect(4 + cell * 14 + 2, floor * 64 + 18, 12, 30);
    }
  }
  const lit = new THREE.CanvasTexture(litCanvas as HTMLCanvasElement);
  lit.colorSpace = THREE.SRGBColorSpace;
  lit.wrapS = lit.wrapT = THREE.RepeatWrapping;
  lit.repeat.set(3, floors / 4);
  host.landmarkWindows.push({ material: wall, day: facade, lit, dayEmissive: new THREE.Color("#3a3936") });
  host.disposables.push(wall, facade, lit);
  const eyebrow = material("#ffffff", 0.25);
  for (const side of [-1, 1]) {
    const accent = material(side < 0 ? "#8fe0e6" : "#f7b3cf", 0.3);
    const glow = material(side < 0 ? "#6ff2ff" : "#ff7ac8", neon ? 1.6 : 0.5);
    const cx = side * 13;
    mesh(new THREE.BoxGeometry(12, h, 12).translate(0, h / 2, 0), wall, group, cx, 0, 0);
    // 眉檐：每层一道薄板，四面出挑 0.9。
    const ledges = new THREE.InstancedMesh(new THREE.BoxGeometry(13.8, 0.28, 13.8), eyebrow, floors);
    for (let f = 0; f < floors; f += 1) {
      host.compose(0, ((f + 1) * h) / floors - h / floors * 0.22, 0, 0, 1, 1, 1);
      ledges.setMatrixAt(f, host.matrix);
    }
    ledges.position.set(cx, 0, 0); ledges.castShadow = true;
    group.add(ledges); host.disposables.push(ledges.geometry);
    // 四角粉彩竖鳍。
    for (const [fx, fz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) mesh(new THREE.BoxGeometry(0.9, h + 1.5, 0.9).translate(0, (h + 1.5) / 2, 0), accent, group, cx + fx * 6.1, 0, fz * 6.1);
    // 阶梯塔冠：三级收分 + 旗杆尖。
    let top = h;
    for (const [w, t] of [[10, 3], [7.5, 3], [5, 3.5]] as Array<[number, number]>) {
      mesh(new THREE.BoxGeometry(w, t, w).translate(0, t / 2, 0), white, group, cx, top, 0);
      mesh(new THREE.BoxGeometry(w + 0.3, 0.35, w + 0.3), glow, group, cx, top + t, 0); // 每级霓虹勾边
      top += t;
    }
    mesh(new THREE.CylinderGeometry(0.15, 0.3, 7, 6).translate(0, 3.5, 0), steel, group, cx, top, 0);
    // 塔身竖向霓虹（朝外一面中线）。
    mesh(new THREE.BoxGeometry(0.35, h * 0.85, 0.35).translate(0, h * 0.425, 0), glow, group, cx + side * 6.15, h * 0.08, 0);
  }
  // 双塔连廊（白色，霓虹下沿）。
  mesh(new THREE.BoxGeometry(14, 2.6, 3.4).translate(0, 1.3, 0), white, group, 0, h * 0.55, 0);
}
