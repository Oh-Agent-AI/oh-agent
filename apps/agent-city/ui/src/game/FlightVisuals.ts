/**
 * FlightVisuals（§4/G1.4，CALIBRATION_SPEC §5 R3）：程序化双翼飞机 + 圆环 + 轻反馈。
 * 机身轮廓（Lathe 半径曲线）、圆角翼尖与 Fresnel 边缘光的造型/手法参照 tinyskies
 * `BiplaneMesh.ts` / `RimLight.ts`（commit 2659a5c；作者已授权参考与移植，
 * 见 TINYSKIES_PORTING_ANALYSIS.md），按城市尺度与现有材质体系重写。
 *
 * 坐标约定（全部部件共用，错一个就拼出"翼面顺着机身躺着"的怪物）：机头 +X、头顶 +Y、右翼 +Z。
 * 几何体在 r=1 的单位空间里建，静态部件按材质合并后整体缩放 r；会动的部件（副翼×2/升降舵/
 * 方向舵/螺旋桨/围巾）各自成 Mesh，几何体以铰链为原点，旋转即偏转。
 * 绘制预算：11 个 Mesh = 11 次 draw call（IMPLEMENTATION_PLAN §10：游戏模式整体新增 ≤20）。
 * 涂装贴图是两张 canvas 程序化纹理（机身 1024×384、翼面图集 512×1024），不携带外部资源。
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createRenderCanvas, renderContext2D, type RenderCanvas, type RenderContext2D } from "../engine/renderCanvas";
import type { FlightSimState, FlightParams } from "./FlightSimulation";
import type { CourseRing } from "./RaceCourse";

const RING_ACTIVE_COLOR = new THREE.Color("#8fe3ff");
const RING_NEAR_COLOR = new THREE.Color("#4d7d99");
const RING_FAR_COLOR = new THREE.Color("#27414f");
const RIM_COLOR = new THREE.Color("#ffeebb");

const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const PROPELLER_X = 1.72;

/** 翼面几何（r=1 单位空间）：上翼前缘 +0.75 / 后缘 -0.25，副翼占外侧 z∈[1.17,2.1] 的后缘 28%。 */
const UPPER_Y = 0.88;
const LOWER_Y = -0.32;
const WING_THICKNESS = 0.1;
const AILERON_HINGE_X = 0.03;
const ELEVATOR_HINGE_X = -2.0;
const RUDDER_HINGE_X = -2.0;
const ELEVATOR_Y = 0.04;

/** 偏转上限（rad）：视觉夸张量，方向由 update() 里的符号推导注释钉住。 */
const AILERON_MAX = 0.5;
const ELEVATOR_MAX = 0.45;
const RUDDER_MAX = 0.5;

const SCARF_SEGMENTS = 10;

/** Fresnel 边缘光：onBeforeCompile 注入片元，零额外 draw call（参照 tinyskies RimLight）。 */
function addRimLight(material: THREE.MeshStandardMaterial, intensity = 0.25, power = 3.5): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: RIM_COLOR };
    shader.uniforms.rimIntensity = { value: intensity };
    shader.uniforms.rimPower = { value: power };
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform vec3 emissive;", "uniform vec3 emissive;\nuniform vec3 rimColor;\nuniform float rimIntensity;\nuniform float rimPower;")
      .replace("#include <dithering_fragment>", `vec3 rimViewDir = normalize(vViewPosition);
vec3 rimNormal = normalize(normal);
float rimFresnel = 1.0 - abs(dot(rimViewDir, rimNormal));
gl_FragColor.rgb += rimColor * rimIntensity * pow(rimFresnel, rimPower);
#include <dithering_fragment>`);
  };
  material.needsUpdate = true;
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/** 确定性伪随机：涂装做旧斑点每次启动一致，截图可复现。 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────── 几何工具 ─────────────────────────────

/** 平移 / 非均匀缩放 / 绕 Z 旋转（法线随之变换）。 */
function placed(
  geometry: THREE.BufferGeometry,
  x: number, y: number, z: number,
  scale: [number, number, number] = [1, 1, 1],
  rotZ = 0,
): THREE.BufferGeometry {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(AXIS_Z, rotZ),
    new THREE.Vector3(...scale),
  );
  return geometry.applyMatrix4(matrix);
}

/** 两点之间的细圆柱（斜撑 / 拉线 / 起落架）。 */
function strutBetween(a: [number, number, number], b: [number, number, number], radius: number, radial = 6): THREE.BufferGeometry {
  const from = new THREE.Vector3(...a);
  const to = new THREE.Vector3(...b);
  const geometry = new THREE.CylinderGeometry(radius, radius, from.distanceTo(to), radial, 1);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(AXIS_Y, to.clone().sub(from).normalize());
  return geometry.applyMatrix4(new THREE.Matrix4().compose(from.clone().add(to).multiplyScalar(0.5), quaternion, new THREE.Vector3(1, 1, 1)));
}

/**
 * 翼面平面形：弦向 X（前缘在 x1）、翼展 Z、厚度 Y，四角各自圆角 [x1z1, x1z0, x0z0, x0z1]。
 * 轮廓内缩一个倒角量再挤出，外廓尺寸才等于传入值——相邻的固定翼面与活动翼面才能严丝合缝。
 */
function planform(
  x0: number, x1: number, z0: number, z1: number,
  radii: [number, number, number, number],
  thickness: number,
): THREE.BufferGeometry {
  const bevel = thickness * 0.3;
  const ax0 = x0 + bevel, ax1 = x1 - bevel, az0 = z0 + bevel, az1 = z1 - bevel;
  const limit = Math.min(ax1 - ax0, az1 - az0) / 2;
  const [a, b, c, d] = radii.map((radius) => clamp(radius - bevel, 0, limit)) as [number, number, number, number];
  const shape = new THREE.Shape();
  shape.moveTo(ax0 + c, az0);
  shape.lineTo(ax1 - b, az0);
  shape.quadraticCurveTo(ax1, az0, ax1, az0 + b);
  shape.lineTo(ax1, az1 - a);
  shape.quadraticCurveTo(ax1, az1, ax1 - a, az1);
  shape.lineTo(ax0 + d, az1);
  shape.quadraticCurveTo(ax0, az1, ax0, az1 - d);
  shape.lineTo(ax0, az0 + c);
  shape.quadraticCurveTo(ax0, az0, ax0 + c, az0);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6,
  });
  geometry.translate(0, 0, -(thickness - 2 * bevel) / 2);
  geometry.rotateX(Math.PI / 2); // 形状 y → +Z（翼展），挤出轴 → Y（厚度）
  return geometry;
}

/** 垂尾轮廓在 XY 平面，沿 Z 挤出薄板。points 为逆时针折线，corner 处用 quad 圆角。 */
function finPlate(shape: THREE.Shape, thickness: number): THREE.BufferGeometry {
  const bevel = thickness * 0.3;
  const depth = thickness - 2 * bevel;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6,
  });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

function finGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-1.3, 0.05);
  shape.lineTo(-1.78, 0.8);
  shape.quadraticCurveTo(-1.86, 0.95, -1.97, 0.95);
  shape.lineTo(-1.985, 0.95);
  shape.lineTo(-1.985, 0.05);
  shape.lineTo(-1.3, 0.05);
  return finPlate(shape, 0.06);
}

function rudderGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-2.0, 0.05);
  shape.lineTo(-2.0, 0.97);
  shape.lineTo(-2.27, 0.97);
  shape.quadraticCurveTo(-2.34, 0.97, -2.34, 0.9);
  shape.lineTo(-2.3, 0.08);
  shape.lineTo(-2.2, 0.05);
  shape.lineTo(-2.0, 0.05);
  return finPlate(shape, 0.05);
}

/** 机身：LatheGeometry 的母线是 (半径, 轴向)，旋转后轴向 y → +X，所以母线必须从机尾排到机头。 */
function fuselageGeometry(): THREE.BufferGeometry {
  const body = new THREE.SplineCurve([
    new THREE.Vector2(-2.3, 0),
    new THREE.Vector2(-2.25, 0.06),
    new THREE.Vector2(-1.9, 0.11),
    new THREE.Vector2(-1.2, 0.21),
    new THREE.Vector2(-0.5, 0.36),
    new THREE.Vector2(0.1, 0.45),
    new THREE.Vector2(0.7, 0.48),
    new THREE.Vector2(1.2, 0.48),
    new THREE.Vector2(1.5, 0.47),
  ]).getPoints(36);
  const profile = body.map((point) => new THREE.Vector2(Math.max(0, point.y), point.x));
  // 整流罩前缘用显式点，避免样条在折角处过冲；末点半径 0 把机头封成平面。
  profile.push(
    new THREE.Vector2(0.45, 1.58),
    new THREE.Vector2(0.4, 1.64),
    new THREE.Vector2(0.2, 1.66),
    new THREE.Vector2(0, 1.66),
  );
  const geometry = new THREE.LatheGeometry(profile, 28);
  geometry.rotateZ(-Math.PI / 2);
  return geometry;
}

/** 木质桨叶：沿 +Y 延伸，根部宽、尖部窄，扭转从 0.5rad 渐变到 0.2rad；桨尖涂黄。 */
function bladeGeometry(): THREE.BufferGeometry {
  const root = 0.06, length = 0.8;
  const box = new THREE.BoxGeometry(0.045, length, 0.15, 1, 8, 1);
  box.translate(0, root + length / 2, 0);
  const position = box.attributes.position;
  for (let index = 0; index < position.count; index += 1) {
    const t = (position.getY(index) - root) / length;
    const twist = THREE.MathUtils.lerp(0.5, 0.2, t);
    const x = position.getX(index);
    const z = position.getZ(index) * (1 - 0.4 * t);
    position.setX(index, x * Math.cos(twist) + z * Math.sin(twist));
    position.setZ(index, -x * Math.sin(twist) + z * Math.cos(twist));
  }
  const flat = box.toNonIndexed();
  box.dispose();
  flat.computeVertexNormals();
  const colors = new Float32Array(flat.attributes.position.count * 3);
  const wood = new THREE.Color("#9a6a3c");
  const tip = new THREE.Color("#e8c24a");
  for (let face = 0; face < flat.attributes.position.count; face += 3) {
    const centroid = (flat.attributes.position.getY(face) + flat.attributes.position.getY(face + 1) + flat.attributes.position.getY(face + 2)) / 3;
    const color = (centroid - root) / length > 0.88 ? tip : wood;
    for (let corner = 0; corner < 3; corner += 1) color.toArray(colors, (face + corner) * 3);
  }
  flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return flat;
}

function painted(geometry: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const color = new THREE.Color(hex);
  const colors = new Float32Array(flat.attributes.position.count * 3);
  for (let index = 0; index < flat.attributes.position.count; index += 1) color.toArray(colors, index * 3);
  flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return flat;
}

/** 合并同材质几何体：Extrude 是非索引、其余是索引，合并前统一成非索引；pivot 把铰链移到原点。 */
function mergeParts(parts: THREE.BufferGeometry[], scale: number, pivot: [number, number, number] = [0, 0, 0]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts.map((part) => (part.index ? part.toNonIndexed() : part)));
  if (!merged) throw new Error("FlightVisuals: 几何体属性集不一致，无法合并");
  for (const part of parts) part.dispose();
  return merged.translate(-pivot[0], -pivot[1], -pivot[2]).scale(scale, scale, scale);
}

// ───────────────────────────── UV 投影 ─────────────────────────────
// Lathe / Extrude 自带 UV 各管各的，涂装需要一张贴图贯穿机身与翼面，所以统一按模型空间位置平面投影。

function remapUV(geometry: THREE.BufferGeometry, map: (x: number, y: number, z: number) => [number, number]): THREE.BufferGeometry {
  const position = geometry.attributes.position;
  const uv = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index += 1) {
    const [u, v] = map(position.getX(index), position.getY(index), position.getZ(index));
    uv[index * 2] = u;
    uv[index * 2 + 1] = v;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}

const BODY_W = 1024, BODY_H = 384;
const BODY_X0 = -2.4, BODY_X1 = 1.8, BODY_Y0 = -0.6, BODY_Y1 = 1.0;
const bodyPx = (x: number) => ((x - BODY_X0) / (BODY_X1 - BODY_X0)) * BODY_W;
const bodyPy = (y: number) => ((BODY_Y1 - y) / (BODY_Y1 - BODY_Y0)) * BODY_H;

/** 机身侧视投影：沿 Z 压平，左右舷同图（圆标/条纹左右对称，无需镜像）。 */
function bodyUV(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  return remapUV(geometry, (x, y) => [
    clamp(bodyPx(x) / BODY_W, 0.002, 0.998),
    clamp(1 - bodyPy(y) / BODY_H, 0.002, 0.998),
  ]);
}

const WING_ATLAS_W = 512, WING_ATLAS_H = 1024;
type Tile = { x: number; y: number; w: number; h: number };
const WING_TILE: Tile = { x: 0, y: 0, w: 256, h: 1024 };
const TAIL_TILE: Tile = { x: 256, y: 0, w: 256, h: 608 };

/** 翼面俯视投影：按「所属整块翼面」归一化（副翼与固定翼共用同一映射，肋条才能连续穿过铰链）。 */
function wingUV(geometry: THREE.BufferGeometry, tile: Tile, leadX: number, chord: number, zMin: number, span: number): THREE.BufferGeometry {
  return remapUV(geometry, (x, _y, z) => {
    const u = clamp((leadX - x) / chord, 0.01, 0.99);
    const v = clamp((z - zMin) / span, 0.01, 0.99);
    return [(tile.x + u * tile.w) / WING_ATLAS_W, 1 - (tile.y + v * tile.h) / WING_ATLAS_H];
  });
}

// ───────────────────────────── 涂装贴图 ─────────────────────────────

function canvas2d(width: number, height: number): { canvas: RenderCanvas; ctx: RenderContext2D } {
  const canvas = createRenderCanvas(width, height);
  return { canvas, ctx: renderContext2D(canvas) };
}

function toTexture(canvas: RenderCanvas): THREE.Texture {
  const texture = new THREE.Texture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function drawRoundel(ctx: RenderContext2D, x: number, y: number, radius: number): void {
  const rings: Array<[string, number]> = [["#1f3a78", 1], ["#f5efde", 0.72], ["#d63a2a", 0.44]];
  for (const [color, scale] of rings) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius * scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(20, 22, 30, 0.45)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function paintFabricTile(ctx: RenderContext2D, tile: Tile, ribs: number, roundelFractions: number[], seed: number): void {
  const random = seededRandom(seed);
  const { x: ox, y: oy, w, h } = tile;
  ctx.fillStyle = "#eadfc4";
  ctx.fillRect(ox, oy, w, h);
  // 布面做旧：大面积浅色斑块，别让翼面像一张平涂纸。
  for (let blotch = 0; blotch < 140; blotch += 1) {
    ctx.fillStyle = random() < 0.5 ? "rgba(150, 120, 70, 0.045)" : "rgba(255, 255, 255, 0.05)";
    ctx.beginPath();
    ctx.ellipse(ox + random() * w, oy + random() * h, 10 + random() * 40, 6 + random() * 24, random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // 前缘胶合板包边 + 木纹。
  const lead = w * 0.14;
  const grain = ctx.createLinearGradient(ox, 0, ox + lead, 0);
  grain.addColorStop(0, "#9d7b4d");
  grain.addColorStop(1, "#b48f5e");
  ctx.fillStyle = grain;
  ctx.fillRect(ox, oy, lead, h);
  for (let line = 0; line < 60; line += 1) {
    ctx.fillStyle = "rgba(70, 45, 20, 0.14)";
    ctx.fillRect(ox + random() * lead, oy + random() * h, 1, 8 + random() * 30);
  }
  ctx.fillStyle = "rgba(60, 40, 20, 0.35)";
  ctx.fillRect(ox + lead, oy, 2, h);
  // 肋条缝线胶带 + 针脚。
  for (let rib = 1; rib < ribs; rib += 1) {
    const y = oy + (rib * h) / ribs;
    ctx.fillStyle = "rgba(250, 244, 224, 0.9)";
    ctx.fillRect(ox + lead + 2, y - 3.5, w - lead - 8, 7);
    ctx.fillStyle = "rgba(110, 92, 58, 0.4)";
    ctx.fillRect(ox + lead + 2, y - 4, w - lead - 8, 1);
    ctx.fillRect(ox + lead + 2, y + 3, w - lead - 8, 1);
    ctx.fillStyle = "rgba(80, 66, 42, 0.55)";
    for (let stitch = ox + lead + 8; stitch < ox + w - 10; stitch += 13) ctx.fillRect(stitch, y - 0.5, 5, 1.5);
  }
  // 后缘锯齿胶带。
  ctx.fillStyle = "#cdbf9a";
  ctx.fillRect(ox + w - 9, oy, 9, h);
  for (const fraction of roundelFractions) drawRoundel(ctx, ox + w * 0.52, oy + h * fraction, w * 0.31);
  // 图集内部不同块之间不能互相渗色：边缘 3px 与布面同色，clamp 到边缘采样不会拉出别的图块。
  ctx.fillStyle = "#d8cba9";
  ctx.fillRect(ox, oy, w, 3);
  ctx.fillRect(ox, oy + h - 3, w, 3);
}

function makeWingTexture(): THREE.Texture {
  const { canvas, ctx } = canvas2d(WING_ATLAS_W, WING_ATLAS_H);
  ctx.fillStyle = "#eadfc4";
  ctx.fillRect(0, 0, WING_ATLAS_W, WING_ATLAS_H);
  // 圆标在翼展两侧各一：中心距翼展中线 1.45 / 4.2 = 0.345。
  paintFabricTile(ctx, WING_TILE, 12, [0.5 - 0.345, 0.5 + 0.345], 0x51a7);
  paintFabricTile(ctx, TAIL_TILE, 8, [], 0x2c91);
  return toTexture(canvas);
}

function makeBodyTexture(): THREE.Texture {
  const { canvas, ctx } = canvas2d(BODY_W, BODY_H);
  const random = seededRandom(0xa17c);
  ctx.fillStyle = "#c8452c";
  ctx.fillRect(0, 0, BODY_W, BODY_H);

  // 腹部压暗、背部提亮：Lathe 单一圆柱的光照单调，涂装补一层体积感。
  const belly = ctx.createLinearGradient(0, bodyPy(-0.05), 0, bodyPy(-0.52));
  belly.addColorStop(0, "rgba(0, 0, 0, 0)");
  belly.addColorStop(1, "rgba(0, 0, 0, 0.3)");
  ctx.fillStyle = belly;
  ctx.fillRect(0, bodyPy(-0.05), BODY_W, bodyPy(-0.6) - bodyPy(-0.05));
  const back = ctx.createLinearGradient(0, bodyPy(0.5), 0, bodyPy(0.25));
  back.addColorStop(0, "rgba(255, 255, 255, 0.1)");
  back.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = back;
  ctx.fillRect(0, bodyPy(0.5), BODY_W, bodyPy(0.25) - bodyPy(0.5));

  // 排气熏黑条纹（在铝质整流罩之前画，罩体盖住上沿）。
  for (let streak = 0; streak < 46; streak += 1) {
    ctx.fillStyle = `rgba(25, 18, 12, ${0.03 + random() * 0.07})`;
    ctx.beginPath();
    ctx.ellipse(bodyPx(0.6 + random() * 0.6), bodyPy(-0.1 - random() * 0.32), 20 + random() * 50, 2 + random() * 3, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 奶油色腰线 + 描边。
  const stripeX = bodyPx(-2.05);
  ctx.fillStyle = "#f2e9cf";
  ctx.fillRect(stripeX, bodyPy(-0.1), bodyPx(1.18) - stripeX, 13);
  ctx.fillStyle = "rgba(60, 25, 15, 0.45)";
  ctx.fillRect(stripeX, bodyPy(-0.1), bodyPx(1.18) - stripeX, 1.5);
  ctx.fillRect(stripeX, bodyPy(-0.1) + 12, bodyPx(1.18) - stripeX, 1.5);

  // 蒙皮板缝 + 铆钉。
  ctx.strokeStyle = "rgba(90, 28, 16, 0.75)";
  ctx.lineWidth = 2;
  for (const seamX of [-1.7, -0.35, 0.95]) {
    ctx.beginPath();
    ctx.moveTo(bodyPx(seamX), bodyPy(0.52));
    ctx.lineTo(bodyPx(seamX), bodyPy(-0.52));
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 220, 200, 0.5)";
    for (let rivet = bodyPy(0.5); rivet < bodyPy(-0.5); rivet += 15) {
      ctx.beginPath();
      ctx.arc(bodyPx(seamX) + 6, rivet, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.beginPath();
  ctx.moveTo(bodyPx(-2.2), bodyPy(0.2));
  ctx.lineTo(bodyPx(1.18), bodyPy(0.2));
  ctx.stroke();

  drawRoundel(ctx, bodyPx(-1.0), bodyPy(0.04), 36);

  // 铝质整流罩：横向拉丝 + 散热百叶 + 接缝铆钉环。
  const cowlX = bodyPx(1.18);
  const metal = ctx.createLinearGradient(cowlX, 0, BODY_W, 0);
  metal.addColorStop(0, "#d8dcdf");
  metal.addColorStop(0.6, "#b3b9be");
  metal.addColorStop(1, "#8f969c");
  ctx.fillStyle = metal;
  ctx.fillRect(cowlX, 0, BODY_W - cowlX, BODY_H);
  for (let line = 0; line < 150; line += 1) {
    ctx.fillStyle = `rgba(${random() < 0.5 ? "255,255,255" : "40,45,50"}, ${0.05 + random() * 0.08})`;
    ctx.fillRect(cowlX, random() * BODY_H, BODY_W - cowlX, 1);
  }
  ctx.fillStyle = "rgba(25, 28, 32, 0.85)";
  for (let louvre = 0; louvre < 7; louvre += 1) {
    ctx.beginPath();
    ctx.roundRect(bodyPx(1.3 + louvre * 0.065), bodyPy(0.17), 5, bodyPy(-0.17) - bodyPy(0.17), 2);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(60, 66, 72, 0.7)";
  ctx.fillRect(cowlX - 1, 0, 3, BODY_H);
  ctx.fillStyle = "rgba(240, 244, 246, 0.8)";
  for (let rivet = 8; rivet < BODY_H; rivet += 13) {
    ctx.beginPath();
    ctx.arc(cowlX + 8, rivet, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // 方向舵三色条（法式）：仅画在 y>0.12，避免染到尾部收尖的机身。
  const hinge = bodyPx(RUDDER_HINGE_X);
  const band = (hinge - bodyPx(-2.34)) / 3;
  const bands = ["#1f3a78", "#f5efde", "#d63a2a"];
  const top = bodyPy(0.99), bottom = bodyPy(0.12);
  bands.forEach((color, index) => {
    ctx.fillStyle = color;
    ctx.fillRect(hinge - (index + 1) * band, top, band + 0.5, bottom - top);
  });
  ctx.strokeStyle = "rgba(20, 22, 30, 0.5)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bodyPx(-2.34), top, hinge - bodyPx(-2.34), bottom - top);

  return toTexture(canvas);
}

export class FlightVisuals {
  /** 飞机本体（随 sim 移动）。 */
  readonly group = new THREE.Group();
  /** 场景根（不移动）：环等世界坐标固定对象挂这里，不继承飞机位移。 */
  readonly sceneRoot = new THREE.Group();
  private readonly params: FlightParams;
  private readonly propeller: THREE.Mesh;
  private readonly rudder: THREE.Mesh;
  private readonly elevator: THREE.Mesh;
  private readonly aileronLeft: THREE.Mesh;
  private readonly aileronRight: THREE.Mesh;
  private readonly scarf: THREE.Mesh;
  private readonly scarfPositions: Float32Array;
  private readonly flash: THREE.PointLight;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private clock = 0;
  /** 12 个环共用一个 InstancedMesh（1 次 draw call，§10 绘制预算）。 */
  private ringMesh: THREE.InstancedMesh | null = null;
  private ringData: CourseRing[] = [];
  private ringMatrix = new THREE.Matrix4();
  private ringQuaternion = new THREE.Quaternion();
  private ringAxis = new THREE.Vector3(0, 0, 1);
  private ringNormal = new THREE.Vector3();
  private ringScale = new THREE.Vector3();
  private ringPosition = new THREE.Vector3();

  constructor(params: FlightParams) {
    this.params = params;
    const r = params.planeRadius;
    const bodyTexture = makeBodyTexture();
    const wingTexture = makeWingTexture();
    const bodyMaterial = new THREE.MeshStandardMaterial({ map: bodyTexture, roughness: 0.5, metalness: 0.1 });
    const clothMaterial = new THREE.MeshStandardMaterial({ map: wingTexture, roughness: 0.82 });
    const darkMaterial = new THREE.MeshStandardMaterial({ color: "#2c3238", roughness: 0.6 });
    const glassMaterial = new THREE.MeshStandardMaterial({ color: "#88ccee", roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.65 });
    const propMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 });
    const scarfMaterial = new THREE.MeshStandardMaterial({ color: "#f2b632", roughness: 0.9, side: THREE.DoubleSide });
    const discMaterial = new THREE.MeshBasicMaterial({ color: "#2c3238", transparent: true, opacity: 0.16, depthWrite: false });
    addRimLight(bodyMaterial);
    addRimLight(clothMaterial, 0.2);

    // 上翼（前缘 +0.75 / 后缘 -0.25，弦长 1.0，翼展 4.2）、下翼与平尾的整块映射参数。
    const upperMap = (g: THREE.BufferGeometry) => wingUV(g, WING_TILE, 0.75, 1.0, -2.1, 4.2);
    const lowerMap = (g: THREE.BufferGeometry) => wingUV(g, WING_TILE, 0.55, 0.9, -1.9, 3.8);
    const tailMap = (g: THREE.BufferGeometry) => wingUV(g, TAIL_TILE, -1.55, 0.8, -0.95, 1.9);
    const upperAt = (g: THREE.BufferGeometry) => g.translate(0, UPPER_Y, 0);
    const aileronZ0 = 1.17, aileronZ1 = 2.1;

    // 红色：机身 + 机头桨毂帽 + 固定垂尾（贴机身贴图，侧视投影）。
    const bodyParts = [
      bodyUV(fuselageGeometry()),
      bodyUV(placed(new THREE.SphereGeometry(0.16, 14, 10), PROPELLER_X + 0.02, 0, 0, [1.8, 1, 1])),
      bodyUV(finGeometry()),
    ];

    // 米色布面（静态）：上翼固定段 + 中段后缘 + 下翼 + 固定平尾。
    const clothParts = [
      upperMap(upperAt(planform(AILERON_HINGE_X, 0.75, -2.1, 2.1, [0.38, 0.38, 0, 0], WING_THICKNESS))),
      upperMap(upperAt(planform(-0.25, AILERON_HINGE_X, -aileronZ0 + 0.02, aileronZ0 - 0.02, [0, 0, 0, 0], WING_THICKNESS))),
      lowerMap(placed(planform(-0.35, 0.55, -1.9, 1.9, [0.34, 0.34, 0.3, 0.3], WING_THICKNESS), 0, LOWER_Y, 0)),
      tailMap(placed(planform(-2.0, -1.55, -0.95, 0.95, [0.2, 0.2, 0, 0], 0.07), 0, ELEVATOR_Y, 0)),
    ];

    // 深色：座舱围板 + 飞行员、中段/翼间斜撑、交叉拉线、起落架、排气管、尾撬。
    const darkParts: THREE.BufferGeometry[] = [
      placed(new THREE.SphereGeometry(1, 14, 8), 0.45, 0.47, 0, [0.5, 0.13, 0.26]),
      placed(new THREE.SphereGeometry(1, 12, 10), 0.34, 0.54, 0, [0.2, 0.17, 0.17]),
      placed(new THREE.SphereGeometry(0.16, 12, 10), 0.38, 0.66, 0),
    ];
    const lowerTop = LOWER_Y + WING_THICKNESS / 2;
    const upperBottom = UPPER_Y - WING_THICKNESS / 2;
    for (const side of [-1, 1]) {
      darkParts.push(
        strutBetween([0.55, 0.4, side * 0.12], [0.55, upperBottom + 0.02, side * 0.45], 0.04),
        strutBetween([0.0, 0.36, side * 0.12], [0.0, upperBottom + 0.02, side * 0.45], 0.04),
        strutBetween([0.45, lowerTop - 0.02, side * 1.5], [0.6, upperBottom + 0.02, side * 1.55], 0.045),
        strutBetween([-0.25, lowerTop - 0.02, side * 1.5], [-0.1, upperBottom + 0.02, side * 1.55], 0.045),
        // 翼间交叉拉线（X 形）与机身到外翼的张线。
        strutBetween([0.45, lowerTop, side * 1.5], [-0.1, upperBottom, side * 1.55], 0.011, 4),
        strutBetween([-0.25, lowerTop, side * 1.5], [0.6, upperBottom, side * 1.55], 0.011, 4),
        strutBetween([0.3, 0.42, side * 0.1], [0.3, upperBottom, side * 1.5], 0.01, 4),
        strutBetween([0.25, -0.3, side * 0.1], [0.2, lowerTop, side * 1.5], 0.01, 4),
        // 起落架 V 形腿 + 轮子（轮轴沿 Z，圆柱默认轴 Y 先转到 Z）。
        strutBetween([0.7, -0.38, side * 0.12], [0.82, -0.95, side * 0.62], 0.045),
        strutBetween([0.2, -0.36, side * 0.12], [0.82, -0.95, side * 0.62], 0.045),
        placed(new THREE.CylinderGeometry(0.25, 0.25, 0.12, 20).rotateX(Math.PI / 2), 0.82, -0.95, side * 0.68),
        // 侧置排气管。
        strutBetween([1.05, -0.2, side * 0.46], [0.45, -0.3, side * 0.5], 0.04),
      );
    }
    darkParts.push(
      strutBetween([0.82, -0.95, -0.62], [0.82, -0.95, 0.62], 0.03),
      strutBetween([-2.0, -0.05, 0], [-2.2, -0.28, 0], 0.03),
    );

    // 玻璃：风挡（顶部向后倾）+ 护目镜。
    const glassParts = [
      placed(new THREE.BoxGeometry(0.03, 0.24, 0.56), 0.85, 0.6, 0, [1, 1, 1], 0.45),
      placed(new THREE.SphereGeometry(0.09, 10, 8), 0.5, 0.67, 0, [0.5, 0.8, 1.6]),
    ];

    // 螺旋桨：两片带桨距的木叶 + 黄铜桨毂（绕 X 自转），旁边一张半透明桨盘消除高速转动的频闪感。
    const bladeA = bladeGeometry();
    const bladeB = bladeA.clone().rotateX(Math.PI);
    const propellerGeometry = mergeParts([
      bladeA,
      bladeB,
      painted(new THREE.CylinderGeometry(0.1, 0.1, 0.1, 14).rotateZ(Math.PI / 2), "#c9a24a"),
    ], r);
    const discGeometry = new THREE.CylinderGeometry(0.88 * r, 0.88 * r, 0.01 * r, 28).rotateZ(Math.PI / 2);

    const bodyGeometry = mergeParts(bodyParts, r);
    const clothGeometry = mergeParts(clothParts, r);
    const darkGeometry = mergeParts(darkParts, r);
    const glassGeometry = mergeParts(glassParts, r);

    // 活动舵面：几何体以铰链为原点，Mesh.position 放铰链位置，旋转即偏转。
    const surface = (geometry: THREE.BufferGeometry, pivot: [number, number, number], material: THREE.Material) => {
      const built = mergeParts([geometry], r, pivot);
      const mesh = new THREE.Mesh(built, material);
      mesh.position.set(pivot[0] * r, pivot[1] * r, pivot[2] * r);
      this.disposables.push(built);
      return mesh;
    };
    const aileronGeometry = (side: 1 | -1) => upperMap(upperAt(planform(
      -0.25, AILERON_HINGE_X,
      side > 0 ? aileronZ0 : -aileronZ1, side > 0 ? aileronZ1 : -aileronZ0,
      side > 0 ? [0, 0, 0, 0.2] : [0, 0, 0.2, 0],
      WING_THICKNESS,
    )));
    this.aileronRight = surface(aileronGeometry(1), [AILERON_HINGE_X, UPPER_Y, (aileronZ0 + aileronZ1) / 2], clothMaterial);
    this.aileronLeft = surface(aileronGeometry(-1), [AILERON_HINGE_X, UPPER_Y, -(aileronZ0 + aileronZ1) / 2], clothMaterial);
    this.elevator = surface(
      tailMap(placed(planform(-2.35, ELEVATOR_HINGE_X, -0.95, 0.95, [0, 0, 0.2, 0.2], 0.07), 0, ELEVATOR_Y, 0)),
      [ELEVATOR_HINGE_X, ELEVATOR_Y, 0], clothMaterial,
    );
    this.rudder = surface(bodyUV(rudderGeometry()), [RUDDER_HINGE_X, 0, 0], bodyMaterial);

    this.propeller = new THREE.Mesh(propellerGeometry, propMaterial);
    this.propeller.position.set(PROPELLER_X * r, 0, 0);
    const disc = new THREE.Mesh(discGeometry, discMaterial);
    disc.position.set((PROPELLER_X + 0.04) * r, 0, 0);

    // 围巾：带状网格，每帧改顶点（22 个顶点，CPU 开销可忽略）。
    const scarfGeometry = new THREE.BufferGeometry();
    this.scarfPositions = new Float32Array((SCARF_SEGMENTS + 1) * 2 * 3);
    const scarfIndex: number[] = [];
    for (let segment = 0; segment < SCARF_SEGMENTS; segment += 1) {
      const a = segment * 2;
      scarfIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    scarfGeometry.setIndex(scarfIndex);
    scarfGeometry.setAttribute("position", new THREE.BufferAttribute(this.scarfPositions, 3));
    this.scarf = new THREE.Mesh(scarfGeometry, scarfMaterial);
    this.scarf.scale.setScalar(r);
    this.scarf.frustumCulled = false; // 包围球按初始顶点算，飘动后会漏出球外
    this.updateScarf(0, 0, 0);
    scarfGeometry.computeVertexNormals();

    this.disposables.push(
      bodyGeometry, clothGeometry, darkGeometry, glassGeometry, propellerGeometry, discGeometry, scarfGeometry,
      bodyMaterial, clothMaterial, darkMaterial, glassMaterial, propMaterial, scarfMaterial, discMaterial,
      bodyTexture, wingTexture,
    );
    this.group.add(
      new THREE.Mesh(bodyGeometry, bodyMaterial),
      new THREE.Mesh(clothGeometry, clothMaterial),
      new THREE.Mesh(darkGeometry, darkMaterial),
      new THREE.Mesh(glassGeometry, glassMaterial),
      this.aileronLeft, this.aileronRight, this.elevator, this.rudder,
      this.propeller, disc, this.scarf,
    );
    this.flash = new THREE.PointLight("#ffb257", 0, r * 14, 2);
    this.group.add(this.flash);
  }

  private updateScarf(time: number, speedRatio: number, turnNorm: number): void {
    const positions = this.scarfPositions;
    for (let index = 0; index <= SCARF_SEGMENTS; index += 1) {
      const s = index / SCARF_SEGMENTS;
      const wave = Math.sin(time * 16 - s * 6.5);
      // 颈部在 (0.26, 0.6)，高于座舱围板顶(≈0.60)才看得见；风越大越平直、拖得越长。
      const x = 0.26 - s * (0.6 + 0.35 * speedRatio);
      // 转弯时围巾向转弯反侧甩（相对气流滞后）：turnNorm>0 = 往 +Z 转 → 围巾偏 -Z。
      const z = wave * s * (0.04 + 0.09 * speedRatio) - turnNorm * s * s * 0.2;
      const top = 0.6 - s * s * (0.1 - 0.08 * speedRatio) + Math.sin(time * 11 - s * 5) * 0.025 * s;
      positions.set([x, top, z, x, top - 0.11, z], index * 6);
    }
    this.scarf.geometry.attributes.position.needsUpdate = true;
  }

  /** 每渲染帧：位置 + 朝向（yaw/pitch/roll 均为视觉量）+ 舵面偏转 + 围巾。 */
  update(sim: FlightSimState, dt: number): void {
    this.group.position.set(sim.x, sim.y, sim.z);
    // 前向 = (cos h, 0, sin h)：three 的 yaw 绕 Y，+X 前向 → rotation.y = -heading。
    // 欧拉顺序必须是 偏航 → 俯仰(局部 Z) → 滚转(局部 X，机头轴)：滚转放在俯仰前面就会绕着歪掉的轴转。
    this.group.rotation.set(0, 0, 0);
    this.group.rotateY(-sim.heading);
    const pitch = Math.atan2(sim.verticalSpeed, Math.max(1e-3, sim.speed)) * 0.6;
    this.group.rotateZ(pitch); // 绕 +Z 正转：+X 机头抬向 +Y
    this.group.rotateX(sim.bank); // +bank：右翼(+Z)下沉

    const bankNorm = clamp(sim.bank / this.params.bankMax, -1, 1);
    const turnNorm = clamp(sim.turnRate / this.params.turnRate, -1, 1);
    const climbNorm = clamp(sim.verticalSpeed / (sim.verticalSpeed >= 0 ? this.params.climbRate : this.params.sinkRate), -1, 1);
    // 舵面铰链在前、后缘朝 -X：绕 +Z 转正角 = 后缘下垂；绕 +Y 转正角 = 后缘朝 +Z（右）。
    // 右翼下沉(bank>0) → 右副翼后缘上翘(角度<0)、左副翼下垂(角度>0)；爬升 → 升降舵后缘上翘；右转 → 方向舵后缘朝右。
    this.aileronRight.rotation.z = -AILERON_MAX * bankNorm;
    this.aileronLeft.rotation.z = AILERON_MAX * bankNorm;
    this.elevator.rotation.z = -ELEVATOR_MAX * climbNorm;
    this.rudder.rotation.y = RUDDER_MAX * turnNorm;

    this.clock += dt;
    this.updateScarf(this.clock, clamp(sim.speed / this.params.maxSpeed, 0, 1), turnNorm);
    this.scarf.geometry.computeVertexNormals();
    this.propeller.rotation.x += dt * Math.min(40, 6 + sim.speed);
    if (this.flash.intensity > 0) {
      this.flash.intensity = Math.max(0, this.flash.intensity - dt * 6);
    }
  }

  /** 碰撞温和反馈：短促灯光脉冲（无声、不依赖颜色语义）。 */
  pulseFeedback(): void {
    this.flash.intensity = 5;
  }

  /** 生成/替换路线圆环（一次创建，重试复用；实例化渲染）。
   *  环必须挂在**不动**的 sceneRoot 上——挂在 this.group 上会继承飞机位移
   *  （group.position=飞机位置），环的世界坐标叠加偏移后跟着飞机跑
   *  （2026-10-09 用户实测「环跟着镜头走」）。 */
  setRings(rings: CourseRing[]): void {
    this.clearRings();
    const geometry = new THREE.TorusGeometry(1, 0.07, 8, 40);
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 });
    const mesh = new THREE.InstancedMesh(geometry, material, rings.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // 实例包围球不随矩阵更新，禁用裁剪避免整组消失
    this.ringMesh = mesh;
    this.ringData = rings;
    this.sceneRoot.add(mesh);
    this.updateRings(0, 0);
  }

  /** 每帧环状态：已过的隐藏（零缩放）、当前高亮呼吸、其后渐弱（实例颜色）。 */
  updateRings(elapsed: number, targetIndex: number): void {
    const mesh = this.ringMesh;
    if (!mesh) return;
    for (let index = 0; index < this.ringData.length; index += 1) {
      const ring = this.ringData[index];
      const scale = index < targetIndex ? 0 : index === targetIndex ? ring.radius * (1 + Math.sin(elapsed * 4) * 0.04) : ring.radius;
      this.ringNormal.set(ring.nx, ring.ny, ring.nz).normalize();
      this.ringQuaternion.setFromUnitVectors(this.ringAxis, this.ringNormal);
      this.ringScale.setScalar(scale);
      this.ringMatrix.compose(this.ringPosition.set(ring.x, ring.y, ring.z), this.ringQuaternion, this.ringScale);
      mesh.setMatrixAt(index, this.ringMatrix);
      const color = index === targetIndex ? RING_ACTIVE_COLOR : index - targetIndex <= 3 ? RING_NEAR_COLOR : RING_FAR_COLOR;
      mesh.setColorAt(index, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  clearRings(): void {
    if (this.ringMesh) {
      this.ringMesh.removeFromParent();
      this.ringMesh.geometry.dispose();
      (this.ringMesh.material as THREE.Material).dispose();
      this.ringMesh.dispose();
      this.ringMesh = null;
      this.ringData = [];
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.sceneRoot.removeFromParent();
    this.clearRings();
    for (const disposable of this.disposables) disposable.dispose();
    this.flash.dispose();
  }
}
