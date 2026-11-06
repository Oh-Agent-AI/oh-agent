import type * as THREE from "three";
import type { Landmark } from "../cityPlan";
import type { CityLayout } from "../cityLayout";
import type { NightLights } from "../render/types";
import type { MaterialFactory } from "../render/landmarkMaterials";

/** 造型函数访问渲染器内部状态的窄接口（原先是 cityParts 的 this.*）。 */
export type LandmarkHost = {
  disposables: Array<{ dispose: () => void }>;
  landmarkSpinners: Array<{ object: THREE.Object3D; axis: "x" | "y" | "z"; speed: number }>;
  landmarkWindows: Array<{ material: THREE.MeshLambertMaterial; day: THREE.Texture; lit: THREE.Texture; dayEmissive: THREE.Color }>;
  layout: CityLayout;
  group: THREE.Group;
  nightLights: NightLights | null;
  compose: (x: number, y: number, z: number, rotationY: number, sx: number, sy: number, sz: number) => void;
  matrix: THREE.Matrix4;
  color: THREE.Color;
  spillWhite: THREE.Color;
  positionVector: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scaleVector: THREE.Vector3;
};

export type LandmarkCtx = {
  group: THREE.Group;
  landmark: Landmark;
  mesh: (geometry: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number, ry?: number) => THREE.Mesh;
  /** 按 (color, emissive, side) 缓存的共享材质；之后要改它的调用点必须传 { private: true }。 */
  material: MaterialFactory;
  white: THREE.MeshLambertMaterial;
  steel: THREE.MeshLambertMaterial;
  red: THREE.MeshLambertMaterial;
  cap: number;
  neon: boolean;
  host: LandmarkHost;
};
