import * as THREE from "three";
import { poseMechaModel, setMechaRig } from "./animation";
import { instantiateMechaGlb, type MechaGlbAsset } from "./glbModels";
import { MECHA_METERS_PER_UNIT } from "./models";
import type { GroundHeight } from "./assaultGround";

type Samples = readonly [readonly number[], readonly number[]];
type ContactMesh = { mesh: THREE.SkinnedMesh; samples: Samples };
const cached = new WeakMap<MechaGlbAsset, readonly Samples[]>();

function skinnedMeshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse((object) => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh); });
  return meshes;
}

export function measureAssaultContacts(asset: MechaGlbAsset): readonly Samples[] {
  const existing = cached.get(asset);
  if (existing) return existing;
  const move = asset.manifest.clips.move;
  if (asset.manifest.role !== "Assault" || !move?.loop || !Number.isFinite(move.duration) || move.duration <= 0) throw new Error("invalid Assault move clip");
  const instance = instantiateMechaGlb(asset, MECHA_METERS_PER_UNIT), root = new THREE.Group();
  root.add(instance.wrapper); setMechaRig(root, instance.rig);
  try {
    const meshes = skinnedMeshes(root);
    const candidates = meshes.map((mesh) => {
      const index = mesh.geometry.getAttribute("skinIndex"), weight = mesh.geometry.getAttribute("skinWeight");
      if (!index || !weight || index.count !== weight.count) throw new Error("invalid Assault skin attributes");
      const sides: [number[], number[]] = [[], []];
      for (let i = 0; i < index.count; i++) for (let j = 0; j < 4; j++) {
        if (weight.getComponent(i, j) <= 1e-6) continue;
        const name = mesh.skeleton.bones[index.getComponent(i, j)]?.name;
        const side = name === "footL" || name === "toeL" ? 0 : name === "footR" || name === "toeR" ? 1 : -1;
        if (side === 0 || side === 1) { sides[side].push(i); break; }
      }
      return sides;
    });
    const samples = meshes.map((): [Set<number>, Set<number>] => [new Set(), new Set()]);
    for (let phase = 0; phase < 40; phase++) {
      poseMechaModel(root, "move", phase / 40 * move.duration);
      root.updateMatrixWorld(true);
      for (let m = 0; m < meshes.length; m++) for (let side = 0; side < 2; side++) {
        const mesh = meshes[m]!, bins = new Map<string, { index: number; y: number }>(), point = new THREE.Vector3();
        for (const i of candidates[m]![side]!) {
          mesh.getVertexPosition(i, point); mesh.localToWorld(point); root.worldToLocal(point);
          const key = `${Math.floor(point.x / .4)}:${Math.floor(point.z / .4)}`;
          const previous = bins.get(key);
          if (!previous || point.y < previous.y) bins.set(key, { index: i, y: point.y });
        }
        for (const value of bins.values()) samples[m]![side]!.add(value.index);
      }
    }
    const result: readonly Samples[] = samples.map((pair) => [Array.from(pair[0]), Array.from(pair[1])] as const);
    if (![0, 1].every((side) => result.some((pair) => pair[side]!.length))) throw new Error("missing Assault foot samples");
    cached.set(asset, result);
    return result;
  } finally { instance.dispose(); }
}

export class AssaultContactSampler {
  private readonly meshes: ContactMesh[];
  constructor(root: THREE.Object3D, asset: MechaGlbAsset) {
    const meshes = skinnedMeshes(root), samples = measureAssaultContacts(asset);
    if (meshes.length !== samples.length || meshes.some((mesh, i) => samples[i]!.some((indices) => indices.some((index) => index >= mesh.geometry.getAttribute("position").count)))) throw new Error("Assault contact mesh mismatch");
    this.meshes = meshes.map((mesh, i) => ({ mesh, samples: samples[i]! }));
  }
  clearance(side: 0 | 1, height: GroundHeight): number {
    let minimum = Infinity;
    const point = new THREE.Vector3();
    for (const { mesh, samples } of this.meshes) for (const index of samples[side]) {
      mesh.getVertexPosition(index, point); mesh.localToWorld(point);
      const ground = height(point.x, point.z);
      if (!Number.isFinite(ground)) throw new Error("invalid Assault ground height");
      minimum = Math.min(minimum, point.y - ground);
    }
    if (!Number.isFinite(minimum)) throw new Error("missing Assault foot samples");
    return minimum;
  }
}
