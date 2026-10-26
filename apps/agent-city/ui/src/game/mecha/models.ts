/**
 * 楼尺机甲与外星怪兽。1 世界单位 = 2 米，一格 16 米。
 * 脚底在 y = 0，面朝 -Z（规则 y 减小的方向，也就是 Boss 所在的一侧）。
 * 横竖尺寸收在各自脚印里：机甲 1×1，怪兽 2×2。击退仍由规则结算，这里只出网格。
 */
import * as THREE from "three";
import { createMechaRig, registerMechaRig, type MechaJoint } from "./animation";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Same ratio as `engine/worldScale.ts`. The model test fails if the two diverge. */
export const MECHA_METERS_PER_UNIT = 2;
export const MECHA_CELL_METERS = 16;

const m = (meters: number): number => meters / MECHA_METERS_PER_UNIT;

type Paint = THREE.MeshStandardMaterial;
type Part = {
  kind?: "box" | "cylinder" | "sphere" | "cone";
  mat: Paint;
  w: number;
  h: number;
  d: number;
  x: number;
  y: number;
  z: number;
  rx?: number;
  ry?: number;
  rz?: number;
  name?: string;
  segments?: number;
  bevel?: number;
  joint?: MechaJoint;
};

function material(params: THREE.MeshStandardMaterialParameters, owned: THREE.Material[]): Paint {
  const mat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.62, metalness: 0.18, ...params });
  owned.push(mat);
  return mat;
}

function geometry(part: Part): THREE.BufferGeometry {
  const segments = part.segments ?? 8;
  if (part.kind === "cylinder") return new THREE.CylinderGeometry(m(part.w), m(part.d), m(part.h), segments);
  if (part.kind === "sphere") return new THREE.SphereGeometry(m(part.w), segments, Math.max(6, segments - 2));
  if (part.kind === "cone") return new THREE.ConeGeometry(m(part.w), m(part.h), segments);
  if (part.bevel) {
    const b = m(Math.min(part.bevel, part.w / 4, part.h / 4, part.d / 4));
    const w = m(part.w) / 2 - b, h = m(part.h) / 2 - b;
    const shape = new THREE.Shape();
    shape.moveTo(-w, -h); shape.lineTo(w, -h); shape.lineTo(w, h); shape.lineTo(-w, h); shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: m(part.d) - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 1, steps: 1, curveSegments: 1 });
    geo.translate(0, 0, -m(part.d) / 2 + b);
    return geo;
  }
  return new THREE.BoxGeometry(m(part.w), m(part.h), m(part.d));
}

function assemble(name: string, role: string, parts: (owned: THREE.Material[]) => Part[]): THREE.Group {
  const owned: THREE.Material[] = [];
  const root = new THREE.Group();
  root.name = name;
  root.userData.role = role;
  const rig = createMechaRig(role, MECHA_METERS_PER_UNIT);
  root.add(rig.visual);
  const batches = new Map<THREE.Group, Map<Paint, THREE.BufferGeometry[]>>();
  for (const part of parts(owned)) {
    const mesh = new THREE.Mesh(geometry(part), part.mat);
    mesh.name = part.name ?? "";
    const id = part.joint ?? "body";
    const target = rig.joints.get(id)!;
    mesh.position.set(m(part.x), m(part.y), m(part.z)).sub(rig.origins.get(id)!);
    mesh.rotation.set(part.rx ?? 0, part.ry ?? 0, part.rz ?? 0);
    if (part.name) {
      target.add(mesh);
    } else {
      mesh.updateMatrix();
      if (mesh.geometry.index) {
        const indexed = mesh.geometry;
        mesh.geometry = indexed.toNonIndexed();
        indexed.dispose();
      }
      mesh.geometry.applyMatrix4(mesh.matrix);
      const byMaterial = batches.get(target) ?? new Map<Paint, THREE.BufferGeometry[]>();
      const batch = byMaterial.get(part.mat) ?? [];
      batch.push(mesh.geometry);
      byMaterial.set(part.mat, batch);
      batches.set(target, byMaterial);
    }
  }
  // Batch within each joint so armor remains cheap to draw and follows its limb.
  for (const [target, byMaterial] of batches) for (const [mat, geometries] of byMaterial) {
    const merged = mergeGeometries(geometries);
    if (merged) {
      target.add(new THREE.Mesh(merged, mat));
      for (const geo of geometries) geo.dispose();
    } else {
      for (const geo of geometries) target.add(new THREE.Mesh(geo, mat));
    }
  }
  registerMechaRig(root, rig);
  root.userData.dispose = () => {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    for (const mat of owned) mat.dispose();
  };
  return root;
}

export function disposeMechaModel(root: THREE.Object3D) {
  const dispose = root.userData.dispose;
  if (typeof dispose === "function") dispose();
}

/** Meter-based parts. Chamfers make armor readable without adding surface noise. */
function box(mat: Paint, w: number, h: number, d: number, x: number, y: number, z: number, extra: Partial<Part> = {}): Part {
  return { mat, w, h, d, x, y, z, ...extra };
}

function legs(armor: Paint, joint: Paint, trim: Paint, heavy = false): Part[] {
  return [-1, 1].flatMap((side): Part[] => {
    const x = side * (heavy ? 1.9 : 1.55);
    return [
      box(joint, 2.8, 1, 4.4, x, 0.5, -0.65, { bevel: 0.15 }),
      box(armor, 2.3, 1, 3.6, x, 1.05, -0.75, { bevel: 0.2 }),
      box(armor, 2.25, 3.6, 2.55, x, 3.1, 0, { bevel: 0.25 }),
      box(joint, 1.8, 1.3, 1.8, x, 5.3, 0),
      box(trim, 2.4, 1.5, 0.65, x, 5.35, -1.15, { bevel: 0.15 }),
      box(armor, heavy ? 2.8 : 2.25, 3.35, 2.6, x, 7.6, 0.2, { bevel: 0.25, rz: side * 0.04 }),
    ].map((part, index) => ({ ...part, joint: `${index === 5 ? "leg" : "shin"}-${side < 0 ? "left" : "right"}` as MechaJoint }));
  });
}

/** Gold striker: massive illuminated ram fists and a broad armored silhouette. */
export function createAssault(): THREE.Group {
  return assemble("assault", "Assault", (owned) => {
    const armor = material({ color: "#d4a017", roughness: 0.48, metalness: 0.34 }, owned);
    const dark = material({ color: "#302a24", roughness: 0.7 }, owned);
    const trim = material({ color: "#8b621e", metalness: 0.45 }, owned);
    const glow = material({ color: "#ffe092", emissive: "#ff9c20", emissiveIntensity: 1.8 }, owned);
    return [
      ...legs(armor, dark, trim, true),
      box(dark, 5.5, 1.8, 3.3, 0, 9.8, 0),
      box(armor, 6.6, 5.4, 4.1, 0, 13.4, 0, { bevel: 0.5 }),
      box(trim, 4.3, 2.9, 0.45, 0, 13.8, -2.13, { bevel: 0.18 }),
      box(dark, 2.4, 1.2, 2.5, 0, 16.7, 0),
      box(armor, 2.8, 2.5, 2.7, 0, 18.35, -0.25, { joint: "head", bevel: 0.25 }),
      box(dark, 2.3, 0.85, 0.25, 0, 18.45, -1.63, { joint: "head" }),
      box(glow, 1.95, 0.4, 0.15, 0, 18.5, -1.81, { joint: "head", name: "front" }),
      ...[-1, 1].flatMap((side): Part[] => [
        box(dark, 2.4, 2.4, 2.8, side * 4, 15.1, 0),
        box(armor, 3.8, 2.8, 4, side * 4.6, 15.8, 0, { bevel: 0.45, rz: side * 0.1 }),
        box(trim, 2.7, 3.1, 2.7, side * 4.8, 13.1, -0.25, { bevel: 0.2, rx: -0.15 }),
        box(dark, 2.1, 1.4, 2.1, side * 5.1, 11.4, -0.8),
        box(armor, 3.9, 3.9, 4.5, side * 5.05, 9.75, -1.65, { bevel: 0.4, name: side < 0 ? "gauntlet-left" : "gauntlet-right" }),
        box(dark, 3.3, 3.2, 0.4, side * 5.05, 9.75, -3.98, { bevel: 0.2 }),
        box(glow, 2.6, 0.28, 0.12, side * 5.05, 10.75, -4.22),
        box(glow, 0.28, 2.3, 0.12, side * 5.05 + side * 1.15, 9.75, -4.22),
      ].map((part, index) => ({ ...part, joint: `${index >= 3 ? "forearm" : "arm"}-${side < 0 ? "left" : "right"}` as MechaJoint }))),
    ];
  });
}

/** Blue artillery: narrow body and long shoulder cannon with a recessed muzzle. */
export function createGunner(): THREE.Group {
  return assemble("gunner", "Gunner", (owned) => {
    const armor = material({ color: "#276bd1", roughness: 0.42, metalness: 0.4 }, owned);
    const dark = material({ color: "#172334", roughness: 0.64 }, owned);
    const trim = material({ color: "#459dff", metalness: 0.4 }, owned);
    const glow = material({ color: "#b7f3ff", emissive: "#39d6ff", emissiveIntensity: 1.5 }, owned);
    return [
      ...legs(armor, dark, trim),
      box(dark, 4.2, 1.6, 3, 0, 9.6, 0),
      box(armor, 4.8, 4.7, 3.4, 0, 12.6, 0, { bevel: 0.35 }),
      box(trim, 3.3, 1.5, 0.45, 0, 13.2, -1.8, { bevel: 0.16 }),
      box(dark, 2.1, 0.8, 2, 0, 15.3, 0),
      box(armor, 2.4, 2, 2.4, 0, 16.7, -0.3, { joint: "head", bevel: 0.18 }),
      box(glow, 2.05, 0.38, 0.18, 0, 16.85, -1.6, { joint: "head", name: "front" }),
      box(dark, 3.4, 3.8, 2, 0.4, 13.8, 2.1, { bevel: 0.2 }),
      box(trim, 1.7, 2.5, 2.4, 2.8, 16, 0.1, { joint: "cannon", bevel: 0.2 }),
      box(armor, 2.8, 2.6, 4.1, 2.8, 17.5, 0.7, { joint: "cannon", bevel: 0.3 }),
      box(dark, 1.8, 1.8, 6.3, 2.8, 17.5, -3.8, { joint: "cannon", bevel: 0.15, name: "cannon" }),
      box(trim, 2.2, 2.2, 1.2, 2.8, 17.5, -6.6, { joint: "cannon", bevel: 0.15 }),
      box(dark, 1.4, 1.4, 0.15, 2.8, 17.5, -7.24, { joint: "cannon" }),
      box(glow, 0.16, 1.4, 0.12, 1.96, 17.5, -7.27, { joint: "cannon" }),
      box(glow, 0.16, 1.4, 0.12, 3.64, 17.5, -7.27, { joint: "cannon" }),
      ...[-1, 1].flatMap((side): Part[] => [
        box(armor, 2.6, 2, 2.7, side * 3.35, 14, 0, { bevel: 0.25 }),
        box(dark, 1.4, 2.3, 1.4, side * 3.3, 12.3, -0.1),
        box(armor, 2.1, 2.8, 2.4, side * 3.2, 10.7, -0.9, { bevel: 0.25, rx: -0.2 }),
        box(dark, 1.7, 1.3, 1.7, side * 3.2, 9.2, -1.2, { bevel: 0.1 }),
      ].map((part, index) => ({ ...part, joint: `${index >= 2 ? "forearm" : "arm"}-${side < 0 ? "left" : "right"}` as MechaJoint }))),
    ];
  });
}

/** Jade field engineer: repair claw, twin tanks, medical cross and service drone. */
export function createSupport(): THREE.Group {
  return assemble("support", "Support", (owned) => {
    const armor = material({ color: "#2fbc8c", roughness: 0.5, metalness: 0.22 }, owned);
    const dark = material({ color: "#17352f", roughness: 0.75 }, owned);
    const white = material({ color: "#d5ebe2", roughness: 0.38, metalness: 0.16 }, owned);
    const glow = material({ color: "#dcfff1", emissive: "#64ffbc", emissiveIntensity: 1.35 }, owned);
    return [
      ...legs(armor, dark, white),
      box(dark, 4.8, 1.6, 3.4, 0, 9.6, 0),
      box(armor, 5.7, 4.8, 3.8, 0, 12.6, 0, { bevel: 0.35 }),
      box(white, 2, 2, 0.25, 0, 12.9, -2.04, { bevel: 0.15 }),
      box(glow, 0.45, 0.45, 0.1, 0, 13.35, -2.24, { name: "front" }),
      box(glow, 0.45, 0.45, 0.1, 0, 12.45, -2.24),
      box(glow, 1.35, 0.45, 0.1, 0, 12.9, -2.24),
      box(dark, 1.8, 0.7, 1.9, 0, 15.4, 0),
      box(armor, 2.3, 2, 2.4, 0, 16.75, -0.15, { joint: "head", bevel: 0.2 }),
      box(dark, 1.6, 0.38, 0.15, 0, 16.9, -1.42, { joint: "head" }),
      box(dark, 4.3, 4, 2.3, 0, 12.7, 2.6, { bevel: 0.2, name: "repair-pack" }),
      ...[-1, 1].flatMap((side): Part[] => [
        box(white, 1.2, 3.4, 1.4, side * 1.3, 12.8, 3.55, { bevel: 0.3 }),
        box(armor, 1.35, 0.55, 1.55, side * 1.3, 13.6, 3.55),
        box(white, 2.2, 1.8, 2.7, side * 3.4, 14, 0, { bevel: 0.2 }),
        box(armor, 1.6, 2.6, 1.7, side * 3.7, 12.3, -0.4, { bevel: 0.2 }),
      ].map((part, index) => ({ ...part, joint: index >= 2 ? `arm-${side < 0 ? "left" : "right"}` as MechaJoint : "body" as MechaJoint }))),
      box(dark, 1.6, 1.1, 1.6, -3.7, 10.8, -0.6, { joint: "forearm-left" }),
      box(armor, 1.9, 2.3, 2.2, -3.7, 9.4, -1.1, { joint: "forearm-left", bevel: 0.2 }),
      box(dark, 1.6, 1.3, 1.8, -3.7, 8.1, -1.4, { joint: "forearm-left" }),
      box(dark, 1.4, 1.4, 1.4, 3.7, 10.5, -0.7, { joint: "forearm-right" }),
      box(armor, 1.3, 2.9, 1.4, 3.8, 9.1, -1.1, { joint: "forearm-right", bevel: 0.15, rx: -0.3 }),
      box(white, 2.5, 1.2, 2, 3.8, 7.5, -1.6, { joint: "forearm-right", bevel: 0.2, name: "repair-claw" }),
      ...[-1, 1].map((side): Part => box(dark, 0.6, 1.3, 2.4, 3.8 + side, 7.2, -2.5, { joint: "forearm-right", rz: side * 0.2 })),
      box(glow, 0.8, 0.5, 0.4, 3.8, 7.5, -2.65, { joint: "forearm-right" }),
      box(white, 2, 1.5, 2, -5.1, 17.5, 0.3, { joint: "drone", bevel: 0.25, name: "service-drone" }),
      box(armor, 1.55, 1.25, 0.2, -5.1, 17.5, -0.81, { joint: "drone" }),
      box(glow, 0.3, 0.275, 0.1, -5.1, 17.7875, -0.98, { joint: "drone" }),
      box(glow, 0.3, 0.275, 0.1, -5.1, 17.2125, -0.98, { joint: "drone" }),
      box(glow, 0.85, 0.3, 0.1, -5.1, 17.5, -0.98, { joint: "drone" }),
      box(dark, 3.3, 0.15, 0.5, -5.1, 18.36, 0.3, { joint: "drone" }),
      box(glow, 0.9, 0.3, 0.9, -5.1, 16.56, 0.3, { joint: "drone", bevel: 0.1 }),
    ];
  });
}

/** 外星怪兽：低重心四足，前肢是砸击镰，尾巴是横扫。脚印落在 32 米见方里。 */
export function createBoss(): THREE.Group {
  return assemble("boss", "Boss", (owned) => {
    const hide = material({ color: "#6e3d78", roughness: 0.74, metalness: 0.04 }, owned);
    const plate = material({ color: "#241c30", roughness: 0.58, metalness: 0.16 }, owned);
    const belly = material({ color: "#8d6a90", roughness: 0.8 }, owned);
    const claw = material({ color: "#c8b48a", roughness: 0.4, metalness: 0.2 }, owned);
    const eye = material({ color: "#eaff7a", emissive: "#c6ff2e", emissiveIntensity: 0.95, roughness: 0.2 }, owned);
    const leg = (x: number, z: number, rz: number): Part[] => [
      { mat: hide, w: 1.8, h: 4.6, d: 1.8, x, y: 4.6, z, rz },
      { mat: plate, w: 1.5, h: 3.8, d: 1.6, x: x + Math.sign(x) * 0.8, y: 2.2, z: z + 0.4, rz: rz * 0.4 },
      { mat: claw, w: 2.2, h: 0.5, d: 2.8, x: x + Math.sign(x) * 1.4, y: 0.25, z: z + 0.8 },
    ].map((part) => ({ ...part, joint: `${z < 0 ? "leg" : "rear"}-${x < 0 ? "left" : "right"}` as MechaJoint }));
    return [
      box(plate, 3.4, 3.4, 0.65, 0, 6.9, -5.95, { bevel: 0.4 }),
      box(eye, 2.1, 2.1, 0.35, 0, 6.9, -6.5, { bevel: 0.3, name: "chest-core" }),
      box(plate, 3, 4.8, 3.4, -4.2, 9.8, -3.5, { bevel: 0.3, rz: 0.3 }),
      box(plate, 3, 4.8, 3.4, 4.2, 9.8, -3.5, { bevel: 0.3, rz: -0.3 }),
      box(plate, 1.85, 0.45, 1.85, 0, 15.65, -3.2, { kind: "cylinder" }),
      box(eye, 1.2, 0.3, 1.2, 0, 16.03, -3.2, { kind: "cylinder", name: "reactor" }),
      ...leg(-4.2, -3.2, 0.35),
      ...leg(4.2, -3.2, -0.35),
      ...leg(-4.6, 4.4, 0.45),
      ...leg(4.6, 4.4, -0.45),
      { mat: belly, w: 8, h: 4.2, d: 14, x: 0, y: 6.6, z: 1.2 },
      { mat: hide, w: 10, h: 7.4, d: 15, x: 0, y: 10.4, z: 0.6, bevel: 0.55 },
      { mat: plate, w: 7, h: 1.6, d: 10, x: 0, y: 14.6, z: 0.2 },
      { mat: plate, kind: "cone", w: 0.9, h: 4.2, d: 0.9, x: -1.6, y: 17.2, z: -1 },
      { mat: plate, kind: "cone", w: 1.1, h: 6.4, d: 1.1, x: 0.2, y: 18.4, z: 1.4 },
      { mat: plate, kind: "cone", w: 0.8, h: 3.6, d: 0.8, x: 1.8, y: 16.8, z: 3.6 },
      { joint: "head", mat: hide, w: 5.2, h: 4.8, d: 5.4, x: 0, y: 10.2, z: -8.2, bevel: 0.35 },
      { joint: "head", mat: plate, w: 4.2, h: 2.4, d: 3.2, x: 0, y: 12.8, z: -9.4 },
      { joint: "head", mat: claw, w: 1.4, h: 1.6, d: 2.4, x: -1.4, y: 8.6, z: -11 },
      { joint: "head", mat: claw, w: 1.4, h: 1.6, d: 2.4, x: 1.4, y: 8.6, z: -11 },
      { joint: "head", mat: eye, kind: "sphere", w: 0.45, h: 1, d: 1, x: -1.3, y: 10.8, z: -10.8, name: "front", segments: 10 },
      { joint: "head", mat: eye, kind: "sphere", w: 0.45, h: 1, d: 1, x: 1.3, y: 10.8, z: -10.8, segments: 10 },
      { joint: "head", mat: eye, kind: "sphere", w: 0.28, h: 1, d: 1, x: 0, y: 12.2, z: -10.4, segments: 8 },
      { joint: "arm-left", mat: hide, w: 1.6, h: 8, d: 1.6, x: -6.4, y: 16.2, z: -4.2, rz: 0.55 },
      { joint: "arm-left", mat: claw, w: 1.3, h: 7.2, d: 2.4, x: -8.8, y: 20.4, z: -7.2, rz: 0.85, rx: 0.25 },
      { joint: "arm-right", mat: hide, w: 1.6, h: 7, d: 1.6, x: 6.4, y: 15.2, z: -3.4, rz: -0.45 },
      { joint: "arm-right", mat: claw, w: 1.2, h: 6, d: 2, x: 8.4, y: 18.2, z: -6, rz: -0.75 },
      { mat: hide, w: 3.2, h: 2.6, d: 4.2, x: 0, y: 8.4, z: 8.4 },
      { mat: hide, w: 2.4, h: 2, d: 4.4, x: 0, y: 7.2, z: 12.2, rx: 0.35 },
      { mat: plate, w: 3.6, h: 2.2, d: 3.6, x: 0, y: 6.2, z: 15.2 },
    ];
  });
}

/** Independent light raider: low carapace, asymmetric shoulders and pouncing claws. */
export function createRaider(): THREE.Group {
  return assemble("raider", "Raider", (owned) => {
    const armor = material({ color: "#84479a", roughness: 0.6, metalness: 0.2 }, owned);
    const dark = material({ color: "#292239", roughness: 0.65, metalness: 0.3 }, owned);
    const claw = material({ color: "#d4bd8c", roughness: 0.5 }, owned);
    const glow = material({ color: "#fff2a1", emissive: "#ffbb2d", emissiveIntensity: 1.4 }, owned);
    return [
      box(dark, 4.4, 1.8, 6.8, 0, 3.4, 0.7, { bevel: 0.3 }),
      box(armor, 5.8, 3, 7, 0, 5, 0.5, { bevel: 0.5 }),
      box(dark, 4.5, 0.7, 4.8, 0.2, 6.85, 1, { bevel: 0.2 }),
      box(armor, 3.7, 2.5, 2.9, 0, 4.5, -3.7, { joint: "head", bevel: 0.3 }),
      box(dark, 3, 0.9, 0.5, 0, 5.1, -5.3, { joint: "head", bevel: 0.1 }),
      box(glow, 1.2, 0.55, 0.15, 0, 4.9, -5.6, { joint: "head", name: "front" }),
      box(armor, 2.2, 2.2, 3.3, -2.8, 5.5, -0.8, { rz: -0.25, bevel: 0.3 }),
      box(dark, 1.6, 1.6, 2.7, 2.6, 5.3, -0.6, { rz: 0.2, bevel: 0.2 }),
      ...[-1, 1].flatMap((side) => [-2.3, 2.8].flatMap((z): Part[] => [
        box(armor, 1.5, 2.8, 1.6, side * 3.2, 3.1, z, { rz: side * 0.55, bevel: 0.18 }),
        box(dark, 1, 2.3, 1.1, side * 4, 1.65, z - 0.3, { rz: -side * 0.3 }),
        box(claw, 1.5, 0.5, 2.1, side * 4.25, 0.25, z - 0.8, { bevel: 0.1 }),
      ].map((part) => ({ ...part, joint: `${z < 0 ? "leg" : "rear"}-${side < 0 ? "left" : "right"}` as MechaJoint })))),
      box(dark, 1.5, 1, 2.6, 0, 4.2, 4.7, { rx: 0.2, bevel: 0.15 }),
    ];
  });
}
