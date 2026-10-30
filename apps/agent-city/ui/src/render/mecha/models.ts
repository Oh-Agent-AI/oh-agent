/**
 * 楼尺机甲与外星怪兽。1 世界单位 = 2 米，一格 16 米。
 * 脚底在 y = 0，面朝 -Z（规则 y 减小的方向，也就是 Boss 所在的一侧）。
 * 横竖尺寸收在各自脚印里：机甲和小怪 1×1，大怪 2×2。击退仍由规则结算，这里只出网格。
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createMechaRig, registerMechaRig, type MechaJoint } from "./animation";

/** Same ratio as `engine/worldScale.ts`. The model test fails if the two diverge. */
export const MECHA_METERS_PER_UNIT = 2;
export const MECHA_CELL_METERS = 16;
export const MECHA_FACTION_COLORS = { friendly: "#4fd8ff", enemy: "#ff5c72" } as const;

const m = (meters: number): number => meters / MECHA_METERS_PER_UNIT;

type Paint = THREE.MeshStandardMaterial;
type Faction = keyof typeof MECHA_FACTION_COLORS;
type Part = {
  kind?: "box" | "armor" | "cylinder" | "sphere" | "cone";
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
};

function material(params: THREE.MeshStandardMaterialParameters, owned: THREE.Material[]): Paint {
  const mat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.62, metalness: 0.18, ...params });
  owned.push(mat);
  return mat;
}

function factionMaterial(faction: Faction, owned: THREE.Material[]): Paint {
  const color = MECHA_FACTION_COLORS[faction];
  return material({ color, emissive: color, emissiveIntensity: 0.48, roughness: 0.28, metalness: 0.3 }, owned);
}

function geometry(part: Part): THREE.BufferGeometry {
  const segments = part.segments ?? 8;
  if (part.kind === "armor") return new RoundedBoxGeometry(m(part.w), m(part.h), m(part.d), 1, m(part.bevel ?? 0.16));
  if (part.kind === "cylinder") return new THREE.CylinderGeometry(m(part.w), m(part.d), m(part.h), segments);
  if (part.kind === "sphere") return new THREE.SphereGeometry(m(part.w), segments, Math.max(6, segments - 2));
  if (part.kind === "cone") return new THREE.ConeGeometry(m(part.w), m(part.h), segments);
  return new THREE.BoxGeometry(m(part.w), m(part.h), m(part.d));
}

function jointFor(part: Part, role: string): MechaJoint {
  const side = part.x < 0 ? "left" : "right";
  if (role === "Boss") {
    if (Math.abs(part.x) > 5.5 && part.y > 8) return `arm-${side}`;
    if (Math.abs(part.x) > 3.5 && part.y < 6) return `${part.z < 0 ? "leg" : "rear"}-${side}`;
    if (part.z < -6) return "head";
    return "body";
  }
  if (role === "Raider") {
    if (Math.abs(part.x) > 3 && part.y > 3.5) return `arm-${side}`;
    if (Math.abs(part.x) > 2 && part.y < 3.5) return `${part.z < 0 ? "leg" : "rear"}-${side}`;
    if (part.z < -3) return "head";
    return "body";
  }
  if (part.name === "drone") return "drone";
  if (part.name === "railgun" || (role === "Gunner" && part.x > 2 && part.y > 13 && part.z < -2.5)) return "cannon";
  const headHeight = role === "Assault" ? 18 : role === "Gunner" ? 16 : 15.5;
  if (part.y > headHeight && Math.abs(part.x) < 2.5) return "head";
  if (part.y < 9 && Math.abs(part.x) < 3) return `${part.y < 6 ? "shin" : "leg"}-${side}`;
  if (Math.abs(part.x) > 2.4 && part.y > 8) {
    const elbow = role === "Assault" ? 12 : role === "Gunner" ? 11 : 11.5;
    return `${part.y < elbow ? "forearm" : "arm"}-${side}`;
  }
  return "body";
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
    const id = jointFor(part, role);
    const target = rig.joints.get(id)!;
    mesh.position.set(m(part.x), m(part.y), m(part.z)).sub(rig.origins.get(id)!);
    mesh.rotation.set(part.rx ?? 0, part.ry ?? 0, part.rz ?? 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
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

/** 重装近战：独立肩轴、斜盾、内凹胸口和独立重拳。 */
export function createAssault(): THREE.Group {
  return assemble("assault", "Assault", (owned) => {
    const armor = material({ color: "#d9a62b", roughness: 0.4, metalness: 0.48 }, owned);
    const trim = material({ color: "#f2d58a", roughness: 0.36, metalness: 0.5 }, owned);
    const dark = material({ color: "#343b40", roughness: 0.66, metalness: 0.58 }, owned);
    const joint = material({ color: "#1f282e", roughness: 0.78, metalness: 0.22 }, owned);
    const faction = factionMaterial("friendly", owned);
    return [
      { mat: dark, kind: "armor", w: 3.5, h: 0.8, d: 4.7, x: -1.9, y: 0.4, z: -0.2, bevel: 0.18 },
      { mat: dark, kind: "armor", w: 3.5, h: 0.8, d: 4.7, x: 1.9, y: 0.4, z: -0.2, bevel: 0.18 },
      { mat: armor, kind: "armor", w: 2.5, h: 4.2, d: 2.7, x: -1.75, y: 3.1, z: 0.2, rz: -0.06 },
      { mat: armor, kind: "armor", w: 2.5, h: 4.2, d: 2.7, x: 1.75, y: 3.1, z: 0.2, rz: 0.06 },
      { mat: joint, kind: "cylinder", w: 1.05, h: 1.35, d: 1.05, x: -1.7, y: 5.6, z: 0 },
      { mat: joint, kind: "cylinder", w: 1.05, h: 1.35, d: 1.05, x: 1.7, y: 5.6, z: 0 },
      { mat: trim, kind: "armor", w: 2.1, h: 1.5, d: 0.6, x: -1.7, y: 5.8, z: -1.35, bevel: 0.1 },
      { mat: trim, kind: "armor", w: 2.1, h: 1.5, d: 0.6, x: 1.7, y: 5.8, z: -1.35, bevel: 0.1 },
      { mat: dark, kind: "cylinder", w: 0.42, h: 3.4, d: 0.42, x: -2.55, y: 7.8, z: 1.15, rz: -0.12, segments: 6 },
      { mat: dark, kind: "cylinder", w: 0.42, h: 3.4, d: 0.42, x: 2.55, y: 7.8, z: 1.15, rz: 0.12, segments: 6 },
      { mat: armor, kind: "armor", w: 2.9, h: 3.9, d: 3.1, x: -1.55, y: 8.1, z: 0.25, rz: 0.08 },
      { mat: armor, kind: "armor", w: 2.9, h: 3.9, d: 3.1, x: 1.55, y: 8.1, z: 0.25, rz: -0.08 },
      { mat: dark, kind: "armor", w: 5.5, h: 2, d: 3.7, x: 0, y: 10.6, z: 0.2 },
      { mat: joint, w: 3.7, h: 2.4, d: 3.1, x: 0, y: 11.8, z: 0.1 },
      { mat: armor, kind: "armor", w: 6.5, h: 5.5, d: 4.5, x: 0, y: 14.4, z: 0, rx: -0.06, bevel: 0.3 },
      { mat: dark, kind: "armor", w: 4.2, h: 3.2, d: 0.65, x: 0, y: 14.5, z: -2.3, bevel: 0.12 },
      { mat: faction, kind: "armor", w: 1.1, h: 2.5, d: 0.4, x: 0, y: 14.7, z: -2.68, name: "faction", bevel: 0.08 },
      { mat: trim, w: 2.4, h: 0.45, d: 0.5, x: 0, y: 16.3, z: -2.25 },
      { mat: dark, kind: "cylinder", w: 0.85, h: 2.2, d: 0.85, x: -3.7, y: 16.1, z: 0, rz: Math.PI / 2 },
      { mat: dark, kind: "cylinder", w: 0.85, h: 2.2, d: 0.85, x: 3.7, y: 16.1, z: 0, rz: Math.PI / 2 },
      { mat: armor, kind: "armor", w: 3.7, h: 2.5, d: 4.5, x: -4.7, y: 16.8, z: 0, rz: -0.16, bevel: 0.28 },
      { mat: armor, kind: "armor", w: 3.7, h: 2.5, d: 4.5, x: 4.7, y: 16.8, z: 0, rz: 0.16, bevel: 0.28 },
      { mat: faction, w: 2.2, h: 0.35, d: 0.45, x: -4.7, y: 17.2, z: -2.28, rz: -0.16, name: "faction" },
      { mat: faction, w: 2.2, h: 0.35, d: 0.45, x: 4.7, y: 17.2, z: -2.28, rz: 0.16, name: "faction" },
      { mat: dark, kind: "cylinder", w: 1.05, h: 1.2, d: 1.05, x: 0, y: 18.1, z: -0.2 },
      { mat: armor, kind: "armor", w: 2.8, h: 2.6, d: 3, x: 0, y: 19.8, z: -0.5, bevel: 0.24 },
      { mat: faction, kind: "armor", w: 2.2, h: 0.5, d: 0.35, x: 0, y: 20, z: -2, name: "front", bevel: 0.08 },
      { mat: dark, kind: "armor", w: 1.7, h: 3.8, d: 2, x: -4.5, y: 13.5, z: -0.1, rz: -0.12 },
      { mat: joint, kind: "cylinder", w: 0.85, h: 1.9, d: 0.85, x: -4.7, y: 11.5, z: -0.3, rz: Math.PI / 2 },
      { mat: dark, w: 0.65, h: 3.6, d: 1.1, x: -5.15, y: 11.5, z: -0.8, rz: -0.12 },
      { mat: armor, kind: "armor", w: 1.1, h: 6.8, d: 5.5, x: -5.8, y: 11.5, z: -1.8, ry: -0.18, rz: -0.1, bevel: 0.22 },
      { mat: trim, kind: "armor", w: 0.4, h: 4.8, d: 4.1, x: -6.4, y: 11.5, z: -1.9, ry: -0.18, rz: -0.1, bevel: 0.08 },
      { mat: faction, w: 0.35, h: 3.6, d: 0.5, x: -6.47, y: 11.5, z: -4.05, ry: -0.18, rz: -0.1, name: "faction" },
      { mat: dark, kind: "armor", w: 1.9, h: 4.1, d: 2.2, x: 4.4, y: 13.3, z: -0.4, rz: 0.12 },
      { mat: joint, kind: "cylinder", w: 0.9, h: 2, d: 0.9, x: 4.7, y: 11.2, z: -0.8, rz: Math.PI / 2 },
      { mat: armor, kind: "armor", w: 3.5, h: 3.3, d: 4.1, x: 5, y: 9.8, z: -1.6, rx: -0.12, bevel: 0.34, name: "gauntlet-right" },
      { mat: trim, kind: "armor", w: 2.6, h: 0.7, d: 0.7, x: 5, y: 10, z: -3.75, bevel: 0.12 },
    ];
  });
}

/** 射手：稳定脚架、外露长轨道炮、供能滑轨和独立传感器。 */
export function createGunner(): THREE.Group {
  return assemble("gunner", "Gunner", (owned) => {
    const armor = material({ color: "#427fce", roughness: 0.4, metalness: 0.5 }, owned);
    const trim = material({ color: "#b8c9d9", roughness: 0.34, metalness: 0.62 }, owned);
    const dark = material({ color: "#263746", roughness: 0.64, metalness: 0.62 }, owned);
    const joint = material({ color: "#18262f", roughness: 0.8, metalness: 0.2 }, owned);
    const faction = factionMaterial("friendly", owned);
    return [
      { mat: dark, kind: "armor", w: 2.7, h: 0.7, d: 4.2, x: -1.55, y: 0.35, z: 0.5, bevel: 0.16 },
      { mat: dark, kind: "armor", w: 2.7, h: 0.7, d: 4.2, x: 1.55, y: 0.35, z: 0.5, bevel: 0.16 },
      { mat: armor, kind: "armor", w: 1.8, h: 4.8, d: 2, x: -1.4, y: 3.1, z: 0.3, rz: -0.1 },
      { mat: armor, kind: "armor", w: 1.8, h: 4.8, d: 2, x: 1.4, y: 3.1, z: 0.3, rz: 0.1 },
      { mat: joint, kind: "cylinder", w: 0.85, h: 1.25, d: 0.85, x: -1.25, y: 5.8, z: 0 },
      { mat: joint, kind: "cylinder", w: 0.85, h: 1.25, d: 0.85, x: 1.25, y: 5.8, z: 0 },
      { mat: armor, kind: "armor", w: 1.9, h: 3.2, d: 2.2, x: -1.05, y: 7.7, z: 0.2, rz: 0.08 },
      { mat: armor, kind: "armor", w: 1.9, h: 3.2, d: 2.2, x: 1.05, y: 7.7, z: 0.2, rz: -0.08 },
      { mat: dark, kind: "armor", w: 3.8, h: 1.6, d: 2.8, x: 0, y: 9.5, z: 0.2 },
      { mat: armor, kind: "armor", w: 4.4, h: 5.2, d: 3.2, x: 0, y: 12.5, z: 0, bevel: 0.26 },
      { mat: dark, kind: "armor", w: 2.7, h: 3.4, d: 0.45, x: 0, y: 12.7, z: -1.7, bevel: 0.1 },
      { mat: faction, w: 0.45, h: 2.5, d: 0.35, x: 0, y: 12.8, z: -1.95, name: "faction" },
      { mat: dark, kind: "cylinder", w: 0.85, h: 0.8, d: 0.85, x: 0, y: 15.4, z: -0.3 },
      { mat: armor, kind: "armor", w: 2.2, h: 2, d: 2.5, x: 0, y: 16.6, z: -0.5, bevel: 0.2 },
      { mat: faction, kind: "armor", w: 2.5, h: 0.45, d: 0.35, x: 0, y: 16.8, z: -1.8, name: "front", bevel: 0.08 },
      { mat: dark, kind: "cylinder", w: 0.18, h: 2.3, d: 0.18, x: -0.8, y: 18.4, z: 0, segments: 6 },
      { mat: faction, kind: "sphere", w: 0.3, h: 1, d: 1, x: -0.8, y: 19.6, z: 0, name: "faction", segments: 8 },
      { mat: dark, kind: "cylinder", w: 0.65, h: 1.6, d: 0.65, x: -2.4, y: 13.7, z: 0, rz: Math.PI / 2 },
      { mat: armor, kind: "armor", w: 1.7, h: 3.8, d: 2, x: -2.8, y: 11.7, z: -0.2, rz: -0.12 },
      { mat: joint, kind: "cylinder", w: 0.65, h: 1.6, d: 0.65, x: -2.9, y: 9.7, z: -0.3, rz: Math.PI / 2 },
      { mat: dark, kind: "cylinder", w: 0.85, h: 2.2, d: 0.85, x: 2.7, y: 14.5, z: 0.4, rz: Math.PI / 2 },
      { mat: armor, kind: "armor", w: 3.1, h: 2.7, d: 4.8, x: 3.2, y: 15.1, z: -1.8, bevel: 0.24, name: "railgun" },
      { mat: dark, kind: "armor", w: 2.2, h: 1.4, d: 7.8, x: 3.2, y: 15.1, z: -6.4, bevel: 0.12, name: "railgun" },
      { mat: trim, kind: "cylinder", w: 0.28, h: 8.4, d: 0.28, x: 2.5, y: 15.8, z: -6.8, rx: -Math.PI / 2, segments: 6, name: "railgun" },
      { mat: trim, kind: "cylinder", w: 0.28, h: 8.4, d: 0.28, x: 3.9, y: 15.8, z: -6.8, rx: -Math.PI / 2, segments: 6, name: "railgun" },
      { mat: faction, w: 0.35, h: 0.35, d: 7.6, x: 3.2, y: 16.2, z: -6.4, name: "faction" },
      { mat: armor, kind: "cylinder", w: 1.15, h: 1.6, d: 0.85, x: 3.2, y: 15.1, z: -10.8, rx: -Math.PI / 2, name: "cannon" },
      { mat: dark, kind: "armor", w: 2.8, h: 0.6, d: 1.2, x: 3.2, y: 15.1, z: -11.5, bevel: 0.1, name: "railgun" },
      { mat: dark, w: 1.2, h: 3.8, d: 1.2, x: 2.6, y: 12.4, z: -2.3, rx: -0.35 },
      { mat: armor, kind: "armor", w: 3, h: 2, d: 2.4, x: 0, y: 13.3, z: 2.2 },
      { mat: faction, w: 1.8, h: 0.35, d: 0.4, x: 0, y: 13.5, z: 3.42, name: "faction" },
    ];
  });
}

/** 支援：维修背包、明确关节和带推进器的侧向悬浮无人机。 */
export function createSupport(): THREE.Group {
  return assemble("support", "Support", (owned) => {
    const armor = material({ color: "#43b58d", roughness: 0.44, metalness: 0.38 }, owned);
    const trim = material({ color: "#d0e5dc", roughness: 0.4, metalness: 0.36 }, owned);
    const dark = material({ color: "#29423d", roughness: 0.68, metalness: 0.48 }, owned);
    const joint = material({ color: "#1d302d", roughness: 0.8, metalness: 0.18 }, owned);
    const faction = factionMaterial("friendly", owned);
    return [
      { mat: dark, kind: "armor", w: 2.8, h: 0.7, d: 4, x: -1.5, y: 0.35, z: 0.2, bevel: 0.16 },
      { mat: dark, kind: "armor", w: 2.8, h: 0.7, d: 4, x: 1.5, y: 0.35, z: 0.2, bevel: 0.16 },
      { mat: armor, kind: "armor", w: 2, h: 4.6, d: 2.2, x: -1.35, y: 3, z: 0.2 },
      { mat: armor, kind: "armor", w: 2, h: 4.6, d: 2.2, x: 1.35, y: 3, z: 0.2 },
      { mat: joint, kind: "cylinder", w: 0.85, h: 1.2, d: 0.85, x: -1.3, y: 5.6, z: 0 },
      { mat: joint, kind: "cylinder", w: 0.85, h: 1.2, d: 0.85, x: 1.3, y: 5.6, z: 0 },
      { mat: armor, kind: "armor", w: 2.2, h: 3.2, d: 2.5, x: -1.2, y: 7.5, z: 0.2 },
      { mat: armor, kind: "armor", w: 2.2, h: 3.2, d: 2.5, x: 1.2, y: 7.5, z: 0.2 },
      { mat: dark, kind: "armor", w: 4.4, h: 1.7, d: 3, x: 0, y: 9.2, z: 0.2 },
      { mat: armor, kind: "armor", w: 5.2, h: 5.4, d: 3.6, x: 0, y: 12.3, z: 0, bevel: 0.28 },
      { mat: dark, kind: "armor", w: 3.3, h: 3.3, d: 0.45, x: 0, y: 12.5, z: -1.9, bevel: 0.12 },
      { mat: trim, w: 0.8, h: 2.6, d: 0.35, x: 0, y: 12.5, z: -2.2, name: "front" },
      { mat: trim, w: 2.6, h: 0.8, d: 0.35, x: 0, y: 12.5, z: -2.2 },
      { mat: faction, w: 2.4, h: 0.3, d: 0.35, x: 0, y: 14.4, z: -1.95, name: "faction" },
      { mat: dark, kind: "cylinder", w: 0.8, h: 0.8, d: 0.8, x: 0, y: 15.2, z: -0.2 },
      { mat: armor, kind: "armor", w: 2.5, h: 2.2, d: 2.5, x: 0, y: 16.4, z: -0.3, bevel: 0.22 },
      { mat: faction, w: 1.6, h: 0.45, d: 0.3, x: 0, y: 16.6, z: -1.6, name: "faction" },
      { mat: dark, kind: "cylinder", w: 0.65, h: 1.8, d: 0.65, x: -2.7, y: 14, z: 0.2, rz: Math.PI / 2 },
      { mat: dark, kind: "cylinder", w: 0.65, h: 1.8, d: 0.65, x: 2.7, y: 14, z: 0.2, rz: Math.PI / 2 },
      { mat: armor, kind: "armor", w: 2, h: 2.2, d: 3.4, x: -3.3, y: 14, z: 0.2 },
      { mat: armor, kind: "armor", w: 2, h: 2.2, d: 3.4, x: 3.3, y: 14, z: 0.2 },
      { mat: faction, w: 1.3, h: 0.3, d: 0.35, x: -3.3, y: 14.4, z: -1.52, name: "faction" },
      { mat: faction, w: 1.3, h: 0.3, d: 0.35, x: 3.3, y: 14.4, z: -1.52, name: "faction" },
      { mat: trim, kind: "cylinder", w: 0.85, h: 4.8, d: 0.85, x: -1.25, y: 11.7, z: 2.4 },
      { mat: trim, kind: "cylinder", w: 0.85, h: 4.8, d: 0.85, x: 1.25, y: 11.7, z: 2.4 },
      { mat: dark, kind: "cylinder", w: 0.95, h: 0.6, d: 0.95, x: -1.25, y: 14.4, z: 2.4 },
      { mat: dark, kind: "cylinder", w: 0.95, h: 0.6, d: 0.95, x: 1.25, y: 14.4, z: 2.4 },
      { mat: dark, kind: "armor", w: 1.2, h: 3.6, d: 1.4, x: -3.2, y: 10.8, z: -0.2, rz: -0.1 },
      { mat: joint, kind: "cylinder", w: 0.65, h: 1.4, d: 0.65, x: -3.3, y: 8.8, z: -0.3, rz: Math.PI / 2 },
      { mat: armor, kind: "armor", w: 1.5, h: 3.4, d: 1.8, x: 3.4, y: 11, z: -0.6, rx: -0.2 },
      { mat: joint, kind: "cylinder", w: 0.65, h: 1.5, d: 0.65, x: 3.5, y: 9.2, z: -1, rz: Math.PI / 2 },
      { mat: dark, kind: "cylinder", w: 0.65, h: 3.2, d: 0.85, x: 3.5, y: 8.8, z: -2.6, rx: -Math.PI / 2 },
      { mat: faction, kind: "cylinder", w: 0.85, h: 0.5, d: 0.85, x: 3.5, y: 8.8, z: -4.2, rx: -Math.PI / 2, name: "faction" },
      { mat: dark, w: 3.8, h: 0.45, d: 0.7, x: 2.4, y: 19.1, z: 1.2, name: "drone" },
      { mat: trim, kind: "armor", w: 2.8, h: 1.2, d: 2.2, x: 2.4, y: 19.6, z: 1.2, bevel: 0.2, name: "drone" },
      { mat: armor, kind: "armor", w: 1.2, h: 0.7, d: 2.8, x: 0.7, y: 19.5, z: 1.2, name: "drone" },
      { mat: armor, kind: "armor", w: 1.2, h: 0.7, d: 2.8, x: 4.1, y: 19.5, z: 1.2, name: "drone" },
      { mat: faction, w: 1.5, h: 0.4, d: 0.3, x: 2.4, y: 19.7, z: 0.08, name: "faction" },
      { mat: dark, kind: "cylinder", w: 0.55, h: 0.6, d: 0.55, x: 0.7, y: 18.8, z: 1.2, name: "drone" },
      { mat: dark, kind: "cylinder", w: 0.55, h: 0.6, d: 0.55, x: 4.1, y: 18.8, z: 1.2, name: "drone" },
      { mat: faction, kind: "cone", w: 0.45, h: 0.8, d: 0.45, x: 0.7, y: 18.2, z: 1.2, rz: Math.PI, name: "drone" },
      { mat: faction, kind: "cone", w: 0.45, h: 0.8, d: 0.45, x: 4.1, y: 18.2, z: 1.2, rz: Math.PI, name: "drone" },
    ];
  });
}

/** 大怪：前伸三眼头部、分节腹部、层叠背甲、四足和外张双镰。 */
export function createBoss(): THREE.Group {
  return assemble("boss", "Boss", (owned) => {
    const hide = material({ color: "#795083", roughness: 0.7, metalness: 0.06 }, owned);
    const plate = material({ color: "#41354a", roughness: 0.56, metalness: 0.22 }, owned);
    const ridge = material({ color: "#604c69", roughness: 0.62, metalness: 0.14 }, owned);
    const belly = material({ color: "#977c99", roughness: 0.82 }, owned);
    const claw = material({ color: "#c3b18e", roughness: 0.44, metalness: 0.2 }, owned);
    const faction = factionMaterial("enemy", owned);
    const leg = (x: number, z: number, rz: number): Part[] => [
      { mat: ridge, kind: "armor", w: 2.2, h: 4.8, d: 2.4, x, y: 4.8, z, rz, bevel: 0.2 },
      { mat: plate, kind: "cylinder", w: 1.1, h: 1.8, d: 1.1, x: x + Math.sign(x) * 0.7, y: 3.2, z: z + 0.2, rz: Math.PI / 2 },
      { mat: ridge, kind: "armor", w: 1.8, h: 3.8, d: 2, x: x + Math.sign(x) * 1.1, y: 2.1, z: z + 0.4, rz: rz * 0.45 },
      { mat: claw, kind: "armor", w: 3, h: 0.6, d: 3.5, x: x + Math.sign(x) * 1.8, y: 0.3, z: z - 0.2, bevel: 0.14 },
    ];
    return [
      ...leg(-4.7, -3.5, 0.5),
      ...leg(4.7, -3.5, -0.5),
      ...leg(-4.9, 4.3, 0.55),
      ...leg(4.9, 4.3, -0.55),
      { mat: belly, kind: "armor", w: 8.8, h: 3.4, d: 11.8, x: 0, y: 5.4, z: 1.2, bevel: 0.35 },
      { mat: plate, w: 8.9, h: 0.7, d: 1, x: 0, y: 4.6, z: -4.4 },
      { mat: plate, w: 8.9, h: 0.7, d: 1, x: 0, y: 4.6, z: -0.8 },
      { mat: plate, w: 8.9, h: 0.7, d: 1, x: 0, y: 4.6, z: 2.8 },
      { mat: hide, kind: "armor", w: 11.2, h: 5.6, d: 13, x: 0, y: 8.6, z: 0.8, bevel: 0.5 },
      { mat: plate, kind: "armor", w: 10.5, h: 1.8, d: 5.2, x: 0, y: 11.8, z: -3.2, rx: -0.12, bevel: 0.28 },
      { mat: ridge, kind: "armor", w: 11.2, h: 2.1, d: 5.4, x: 0, y: 12.2, z: 1.2, bevel: 0.3 },
      { mat: plate, kind: "armor", w: 9.2, h: 1.8, d: 4.8, x: 0, y: 11.5, z: 5.3, rx: 0.14, bevel: 0.28 },
      { mat: faction, w: 0.45, h: 0.45, d: 8.4, x: 0, y: 13.35, z: 0.8, name: "faction" },
      { mat: claw, kind: "cone", w: 0.9, h: 4.6, d: 0.9, x: -2.2, y: 14.7, z: -1.8, rz: -0.12 },
      { mat: claw, kind: "cone", w: 1.1, h: 8.8, d: 1.1, x: 0, y: 17.6, z: 1.2 },
      { mat: claw, kind: "cone", w: 0.8, h: 4.2, d: 0.8, x: 2.2, y: 14.4, z: 4, rz: 0.12 },
      { mat: hide, kind: "armor", w: 6.8, h: 4.2, d: 6.8, x: 0, y: 7.7, z: -8.8, rx: -0.18, bevel: 0.42 },
      { mat: plate, kind: "armor", w: 6.3, h: 1.8, d: 4.2, x: 0, y: 10.1, z: -9.2, rx: -0.22, bevel: 0.24 },
      { mat: belly, kind: "armor", w: 5.4, h: 1.4, d: 2.8, x: 0, y: 5.8, z: -11, bevel: 0.2 },
      { mat: claw, kind: "cone", w: 0.65, h: 2.8, d: 0.65, x: -2, y: 5.3, z: -12.2, rx: -Math.PI / 2 },
      { mat: claw, kind: "cone", w: 0.65, h: 2.8, d: 0.65, x: 2, y: 5.3, z: -12.2, rx: -Math.PI / 2 },
      { mat: faction, kind: "sphere", w: 0.65, h: 1, d: 1, x: -1.8, y: 8, z: -12.2, name: "front", segments: 10 },
      { mat: faction, kind: "sphere", w: 0.65, h: 1, d: 1, x: 1.8, y: 8, z: -12.2, segments: 10 },
      { mat: faction, kind: "sphere", w: 0.45, h: 1, d: 1, x: 0, y: 9.6, z: -11.9, segments: 8 },
      { mat: plate, kind: "cylinder", w: 1.2, h: 2.6, d: 1.2, x: -5.8, y: 9.7, z: -3.4, rz: Math.PI / 2 },
      { mat: plate, kind: "cylinder", w: 1.2, h: 2.6, d: 1.2, x: 5.8, y: 9.7, z: -3.4, rz: Math.PI / 2 },
      { mat: hide, kind: "armor", w: 2.2, h: 8.8, d: 2.4, x: -7.2, y: 12, z: -3.8, rz: 0.78, bevel: 0.22 },
      { mat: claw, kind: "cone", w: 1.5, h: 10.5, d: 1.5, x: -10.2, y: 16.4, z: -6.2, rz: 0.8, rx: 0.35 },
      { mat: hide, kind: "armor", w: 2.2, h: 8.4, d: 2.4, x: 7.2, y: 11.8, z: -3.6, rz: -0.76, bevel: 0.22 },
      { mat: claw, kind: "cone", w: 1.5, h: 10, d: 1.5, x: 10, y: 16, z: -5.8, rz: -0.78, rx: 0.32 },
      { mat: faction, kind: "sphere", w: 0.5, h: 1, d: 1, x: -6.2, y: 10.3, z: -4.7, name: "faction", segments: 8 },
      { mat: faction, kind: "sphere", w: 0.5, h: 1, d: 1, x: 6.2, y: 10.3, z: -4.7, name: "faction", segments: 8 },
      { mat: hide, kind: "armor", w: 4.2, h: 3.2, d: 5.2, x: 0, y: 7, z: 8.6, rx: 0.2 },
      { mat: ridge, kind: "armor", w: 3.2, h: 2.5, d: 4.8, x: 0, y: 6.2, z: 12.4, rx: 0.35 },
      { mat: claw, kind: "cone", w: 1.5, h: 5.5, d: 1.5, x: 0, y: 5.2, z: 15.4, rx: Math.PI / 2 },
    ];
  });
}

/** 小怪：前低后高的楔形躯干、后掠节肢和暗色利爪。 */
export function createRaider(): THREE.Group {
  return assemble("raider", "Raider", (owned) => {
    const hide = material({ color: "#825694", roughness: 0.7, metalness: 0.08 }, owned);
    const plate = material({ color: "#3e324b", roughness: 0.58, metalness: 0.2 }, owned);
    const claw = material({ color: "#514b55", roughness: 0.5, metalness: 0.36 }, owned);
    const faction = factionMaterial("enemy", owned);
    const leg = (x: number, z: number): Part[] => [
      { mat: hide, kind: "armor", w: 1.2, h: 3.3, d: 1.4, x, y: 2.6, z, rz: -Math.sign(x) * 0.68, bevel: 0.14 },
      { mat: plate, kind: "cylinder", w: 0.65, h: 1.3, d: 0.65, x: x + Math.sign(x) * 0.75, y: 1.7, z: z + 0.3, rz: Math.PI / 2, segments: 6 },
      { mat: plate, kind: "armor", w: 0.9, h: 2.1, d: 1.1, x: x + Math.sign(x) * 1.05, y: 1.18, z: z + 0.5, rz: Math.sign(x) * 0.32, bevel: 0.1 },
      { mat: claw, kind: "armor", w: 1.1, h: 0.35, d: 2.1, x: x + Math.sign(x) * 1.25, y: 0.32, z: z - 0.4, bevel: 0.08 },
      { mat: claw, kind: "cone", w: 0.32, h: 1.4, d: 0.32, x: x + Math.sign(x) * 1.25, y: 0.32, z: z - 1.7, rx: -Math.PI / 2, segments: 6 },
    ];
    return [
      ...leg(-2.4, -1.8),
      ...leg(2.4, -1.8),
      ...leg(-2.7, 2.2),
      ...leg(2.7, 2.2),
      { mat: hide, kind: "armor", w: 5.8, h: 2.8, d: 7.4, x: 0, y: 3.7, z: 0.7, rx: -0.14, bevel: 0.36 },
      { mat: plate, kind: "armor", w: 5.4, h: 1.2, d: 4.4, x: 0, y: 5.3, z: -0.7, rx: -0.2, bevel: 0.2 },
      { mat: plate, kind: "armor", w: 4.4, h: 1.1, d: 3.4, x: 0, y: 5.4, z: 2.9, rx: 0.22, bevel: 0.18 },
      { mat: faction, w: 0.35, h: 0.3, d: 5.8, x: 0, y: 6.05, z: 0.7, rx: -0.05, name: "faction" },
      { mat: claw, kind: "cone", w: 0.55, h: 3.8, d: 0.55, x: 0, y: 5.7, z: 4.4, rx: Math.PI / 2 },
      { mat: hide, kind: "armor", w: 4.2, h: 2.3, d: 4.2, x: 0, y: 3.1, z: -4.3, rx: -0.18, bevel: 0.3 },
      { mat: plate, kind: "armor", w: 3.6, h: 0.8, d: 2.4, x: 0, y: 4.4, z: -4.6, rx: -0.2, bevel: 0.14 },
      { mat: faction, kind: "armor", w: 2.8, h: 0.6, d: 0.35, x: 0, y: 3.5, z: -6.45, name: "front", bevel: 0.1 },
      { mat: plate, kind: "cylinder", w: 0.65, h: 1.4, d: 0.65, x: -3.1, y: 4.3, z: -2.4, rz: Math.PI / 2, segments: 6 },
      { mat: plate, kind: "cylinder", w: 0.65, h: 1.4, d: 0.65, x: 3.1, y: 4.3, z: -2.4, rz: Math.PI / 2, segments: 6 },
      { mat: hide, kind: "armor", w: 1.1, h: 4, d: 1.3, x: -3.8, y: 4.7, z: -2.8, rz: 0.82, bevel: 0.12 },
      { mat: hide, kind: "armor", w: 1.1, h: 4, d: 1.3, x: 3.8, y: 4.7, z: -2.8, rz: -0.82, bevel: 0.12 },
      { mat: claw, kind: "cone", w: 0.7, h: 4.8, d: 0.7, x: -5, y: 6.1, z: -4.2, rz: 0.82, rx: 0.3 },
      { mat: claw, kind: "cone", w: 0.7, h: 4.8, d: 0.7, x: 5, y: 6.1, z: -4.2, rz: -0.82, rx: 0.3 },
      { mat: plate, kind: "armor", w: 2.2, h: 1.5, d: 4.2, x: 0, y: 3.4, z: 5.2, rx: 0.35 },
    ];
  });
}
