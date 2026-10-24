/**
 * 楼尺机甲与外星怪兽。1 世界单位 = 2 米，一格 16 米。
 * 脚底在 y = 0，面朝 -Z（规则 y 减小的方向，也就是 Boss 所在的一侧）。
 * 横竖尺寸收在各自脚印里：机甲 1×1，怪兽 2×2。击退仍由规则结算，这里只出网格。
 */
import * as THREE from "three";

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
  return new THREE.BoxGeometry(m(part.w), m(part.h), m(part.d));
}

function assemble(name: string, role: string, parts: (owned: THREE.Material[]) => Part[]): THREE.Group {
  const owned: THREE.Material[] = [];
  const root = new THREE.Group();
  root.name = name;
  root.userData.role = role;
  for (const part of parts(owned)) {
    const mesh = new THREE.Mesh(geometry(part), part.mat);
    mesh.name = part.name ?? "";
    mesh.position.set(m(part.x), m(part.y), m(part.z));
    mesh.rotation.set(part.rx ?? 0, part.ry ?? 0, part.rz ?? 0);
    root.add(mesh);
  }
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

/** 重装近战：厚肩甲、左盾、右拳。约 22 米高。 */
export function createAssault(): THREE.Group {
  return assemble("assault", "Assault", (owned) => {
    const armor = material({ color: "#d4a017", roughness: 0.48, metalness: 0.34 }, owned);
    const dark = material({ color: "#3a2a12", roughness: 0.82 }, owned);
    const visor = material({ color: "#ffb15a", emissive: "#ff7a18", emissiveIntensity: 0.7, roughness: 0.3 }, owned);
    return [
      { mat: dark, w: 3.4, h: 0.8, d: 4.6, x: -1.8, y: 0.4, z: 0.2 },
      { mat: dark, w: 3.4, h: 0.8, d: 4.6, x: 1.8, y: 0.4, z: 0.2 },
      { mat: armor, w: 2.4, h: 4.4, d: 2.6, x: -1.7, y: 3.2, z: 0 },
      { mat: armor, w: 2.4, h: 4.4, d: 2.6, x: 1.7, y: 3.2, z: 0 },
      { mat: dark, w: 2.6, h: 1.2, d: 2.6, x: -1.7, y: 5.8, z: 0 },
      { mat: dark, w: 2.6, h: 1.2, d: 2.6, x: 1.7, y: 5.8, z: 0 },
      { mat: armor, w: 2.8, h: 4.2, d: 3, x: -1.6, y: 8.4, z: 0.1 },
      { mat: armor, w: 2.8, h: 4.2, d: 3, x: 1.6, y: 8.4, z: 0.1 },
      { mat: dark, w: 5.6, h: 2.2, d: 3.8, x: 0, y: 11, z: 0 },
      { mat: armor, w: 6.6, h: 6.4, d: 4.4, x: 0, y: 15, z: 0 },
      { mat: armor, w: 3.8, h: 1.6, d: 4.2, x: -4.8, y: 17.4, z: 0 },
      { mat: armor, w: 3.8, h: 1.6, d: 4.2, x: 4.8, y: 17.4, z: 0 },
      { mat: dark, w: 3.2, h: 1.4, d: 3.2, x: 0, y: 18.6, z: 0 },
      { mat: armor, w: 2.6, h: 2.6, d: 2.8, x: 0, y: 20.4, z: -0.2 },
      { mat: visor, w: 2, h: 0.45, d: 0.3, x: 0, y: 20.6, z: -1.55, name: "front" },
      { mat: armor, w: 1.3, h: 5.2, d: 2.2, x: -4.2, y: 14.2, z: -0.2 },
      { mat: armor, w: 1.2, h: 7.4, d: 5.2, x: -5.4, y: 12.2, z: -0.4 },
      { mat: dark, w: 1.8, h: 4.2, d: 2, x: 4.4, y: 14.4, z: -0.2 },
      { mat: armor, w: 3.6, h: 3.4, d: 4, x: 5.4, y: 11.2, z: -1.2 },
    ];
  });
}

/** 射手：窄身架和一门收在格子内的轨道炮。 */
export function createGunner(): THREE.Group {
  return assemble("gunner", "Gunner", (owned) => {
    const armor = material({ color: "#3d8bfd", roughness: 0.42, metalness: 0.4 }, owned);
    const dark = material({ color: "#17263d", roughness: 0.78 }, owned);
    const sensor = material({ color: "#b7f3ff", emissive: "#39d6ff", emissiveIntensity: 0.85, roughness: 0.22 }, owned);
    return [
      { mat: dark, w: 2.2, h: 0.6, d: 3.4, x: -1.2, y: 0.3, z: 0.2 },
      { mat: dark, w: 2.2, h: 0.6, d: 3.4, x: 1.2, y: 0.3, z: 0.2 },
      { mat: armor, w: 1.6, h: 6.2, d: 1.8, x: -1.15, y: 3.6, z: 0 },
      { mat: armor, w: 1.6, h: 6.2, d: 1.8, x: 1.15, y: 3.6, z: 0 },
      { mat: dark, w: 3.6, h: 1.6, d: 2.6, x: 0, y: 7.2, z: 0 },
      { mat: armor, w: 4.2, h: 6.6, d: 3, x: 0, y: 11.2, z: 0 },
      { mat: dark, w: 3.4, h: 0.8, d: 2.4, x: 0, y: 14.8, z: -0.4 },
      { mat: armor, w: 2.2, h: 2, d: 2.4, x: 0, y: 16.2, z: -0.3 },
      { mat: sensor, w: 2.6, h: 0.35, d: 0.4, x: 0, y: 16.5, z: -1.5, name: "front" },
      { mat: dark, w: 1.2, h: 3.4, d: 1.2, x: -2.8, y: 12.4, z: 0 },
      { mat: armor, kind: "cylinder", w: 0.45, h: 6.2, d: 0.55, x: 2.6, y: 12.6, z: -3.4, rx: -Math.PI / 2 },
      { mat: dark, kind: "cylinder", w: 0.7, h: 1.1, d: 0.7, x: 2.6, y: 12.6, z: -6.6, rx: -Math.PI / 2 },
      { mat: armor, w: 2.4, h: 1.4, d: 2.2, x: 0, y: 13.6, z: 1.8 },
    ];
  });
}

/** 支援：背后双罐，胸口一盏维修灯。比突击矮一截。 */
export function createSupport(): THREE.Group {
  const root = assemble("support", "Support", (owned) => {
    const armor = material({ color: "#3dba8b", roughness: 0.5, metalness: 0.22 }, owned);
    const dark = material({ color: "#143028", roughness: 0.8 }, owned);
    const lamp = material({ color: "#e9fff4", emissive: "#7dffa8", emissiveIntensity: 0.9, roughness: 0.28 }, owned);
    const tank = material({ color: "#d5ebe2", roughness: 0.35, metalness: 0.12 }, owned);
    return [
      { mat: dark, w: 2.6, h: 0.7, d: 3.6, x: -1.35, y: 0.35, z: 0.15 },
      { mat: dark, w: 2.6, h: 0.7, d: 3.6, x: 1.35, y: 0.35, z: 0.15 },
      { mat: armor, w: 1.9, h: 5.2, d: 2.1, x: -1.3, y: 3.2, z: 0 },
      { mat: armor, w: 1.9, h: 5.2, d: 2.1, x: 1.3, y: 3.2, z: 0 },
      { mat: dark, w: 4.4, h: 1.8, d: 3, x: 0, y: 6.4, z: 0 },
      { mat: armor, w: 5, h: 5.4, d: 3.4, x: 0, y: 9.8, z: -0.1 },
      { mat: lamp, kind: "sphere", w: 0.55, h: 1, d: 1, x: 0, y: 10.2, z: -1.7, name: "front", segments: 10 },
      { mat: armor, w: 2.2, h: 2, d: 2.2, x: 0, y: 13.4, z: -0.2 },
      { mat: dark, w: 1.4, h: 0.4, d: 0.3, x: 0, y: 13.6, z: -1.3 },
      { mat: armor, w: 1.3, h: 4, d: 1.4, x: -3.2, y: 9.2, z: -0.6 },
      { mat: dark, w: 1.1, h: 2.4, d: 1.1, x: 3.1, y: 8.6, z: -1.4 },
      { mat: tank, kind: "cylinder", w: 0.7, h: 3.6, d: 0.7, x: -1.1, y: 11.2, z: 2 },
      { mat: tank, kind: "cylinder", w: 0.7, h: 3.6, d: 0.7, x: 1.1, y: 11.2, z: 2 },
      { mat: dark, w: 3.2, h: 0.6, d: 1.6, x: 0, y: 13.2, z: 2 },
    ];
  });
  root.scale.setScalar(1.22);
  return root;
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
    ];
    return [
      ...leg(-4.2, -3.2, 0.35),
      ...leg(4.2, -3.2, -0.35),
      ...leg(-4.6, 4.4, 0.45),
      ...leg(4.6, 4.4, -0.45),
      { mat: belly, w: 8, h: 4.2, d: 14, x: 0, y: 6.6, z: 1.2 },
      { mat: hide, w: 10, h: 7.4, d: 15, x: 0, y: 10.4, z: 0.6 },
      { mat: plate, w: 7, h: 1.6, d: 10, x: 0, y: 14.6, z: 0.2 },
      { mat: plate, kind: "cone", w: 0.9, h: 4.2, d: 0.9, x: -1.6, y: 17.2, z: -1 },
      { mat: plate, kind: "cone", w: 1.1, h: 6.4, d: 1.1, x: 0.2, y: 18.4, z: 1.4 },
      { mat: plate, kind: "cone", w: 0.8, h: 3.6, d: 0.8, x: 1.8, y: 16.8, z: 3.6 },
      { mat: hide, w: 5.2, h: 4.8, d: 5.4, x: 0, y: 10.2, z: -8.2 },
      { mat: plate, w: 4.2, h: 2.4, d: 3.2, x: 0, y: 12.8, z: -9.4 },
      { mat: claw, w: 1.4, h: 1.6, d: 2.4, x: -1.4, y: 8.6, z: -11 },
      { mat: claw, w: 1.4, h: 1.6, d: 2.4, x: 1.4, y: 8.6, z: -11 },
      { mat: eye, kind: "sphere", w: 0.45, h: 1, d: 1, x: -1.3, y: 10.8, z: -10.8, name: "front", segments: 10 },
      { mat: eye, kind: "sphere", w: 0.45, h: 1, d: 1, x: 1.3, y: 10.8, z: -10.8, segments: 10 },
      { mat: eye, kind: "sphere", w: 0.28, h: 1, d: 1, x: 0, y: 12.2, z: -10.4, segments: 8 },
      { mat: hide, w: 1.6, h: 8, d: 1.6, x: -6.4, y: 16.2, z: -4.2, rz: 0.55 },
      { mat: claw, w: 1.3, h: 7.2, d: 2.4, x: -8.8, y: 20.4, z: -7.2, rz: 0.85, rx: 0.25 },
      { mat: hide, w: 1.6, h: 7, d: 1.6, x: 6.4, y: 15.2, z: -3.4, rz: -0.45 },
      { mat: claw, w: 1.2, h: 6, d: 2, x: 8.4, y: 18.2, z: -6, rz: -0.75 },
      { mat: hide, w: 3.2, h: 2.6, d: 4.2, x: 0, y: 8.4, z: 8.4 },
      { mat: hide, w: 2.4, h: 2, d: 4.4, x: 0, y: 7.2, z: 12.2, rx: 0.35 },
      { mat: plate, w: 3.6, h: 2.2, d: 3.6, x: 0, y: 6.2, z: 15.2 },
    ];
  });
}
