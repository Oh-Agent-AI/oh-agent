/** Exact current render geometry for the explicitly registered building/landmark layer.
 * These are triangle meshes, not inferred final-height boxes or a complete legal world. */
import * as THREE from "three";
import type { RenderedSolid, RenderedSolidSource, RenderedSolidRole } from "./renderedSolidTypes";
import { RENDERED_SOLID_LIMITS } from "./renderedSolidTypes";
export type { RenderedSolidRole } from "./renderedSolidTypes";
export type RenderedSolidRoot = Readonly<{ object: THREE.Object3D; role: RenderedSolidRole }>;
const geometryLifetimes = new WeakMap<THREE.BufferGeometry, { epoch: number }>();
function geometryLifetime(geometry: THREE.BufferGeometry): { epoch: number } {
  let state = geometryLifetimes.get(geometry);
  if (!state) { state = { epoch: 0 }; geometryLifetimes.set(geometry, state); const owned = state; geometry.addEventListener("dispose", () => owned.epoch++); }
  return state;
}

/** Throws rather than silently omitting unsupported or over-budget geometry. */
export function captureRenderedSolids(roots: readonly RenderedSolidRoot[]): RenderedSolidSource {
  const solids: RenderedSolid[] = [], checks: Array<() => boolean> = [];
  const seen = new Set<THREE.Object3D>(); let byteCount = 0, meshCount = 0, vertices = 0, instances = 0, nodes = 0;
  const visible = (o: THREE.Object3D): boolean => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; };
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
    const root = roots[rootIndex]; const membership: THREE.Object3D[] = [];
    root.object.traverse((object) => {
      if (++nodes > 200000) throw new Error("rendered-solids-budget");
      membership.push(object);
      if (!(object instanceof THREE.Mesh) || object.userData.cityDrivingNonSolid === true || seen.has(object)) return;
      seen.add(object); const mesh = object;
      if (++meshCount > RENDERED_SOLID_LIMITS.meshes) throw new Error("rendered-solids-budget");
      const wasVisible = visible(mesh);
      checks.push(() => visible(mesh) === wasVisible);
      if (!wasVisible) return;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || mesh.morphTargetInfluences?.some((x) => x !== 0)) throw new Error("unsupported-rendered-solid-deformation");
      const geometry = mesh.geometry, attribute = geometry.getAttribute("position"), index = geometry.index;
      const lifetime = geometryLifetime(geometry), epoch = lifetime.epoch;
      if (!attribute || attribute.itemSize !== 3) throw new Error("invalid-rendered-solid-position");
      vertices += attribute.count;
      if (vertices > RENDERED_SOLID_LIMITS.vertices) throw new Error("rendered-solids-budget");
      const positions = new Float32Array(attribute.count * 3);
      for (let i = 0; i < attribute.count; i++) positions.set([attribute.getX(i), attribute.getY(i), attribute.getZ(i)], i * 3);
      if (!positions.every(Number.isFinite)) throw new Error("invalid-rendered-solid-position");
      const length = index?.count ?? attribute.count, selected: number[] = [];
      if (length > 3000000) throw new Error("rendered-solids-budget");
      const drawStart = geometry.drawRange.start, drawEnd = Math.min(length, drawStart + geometry.drawRange.count);
      if (!Number.isSafeInteger(drawStart) || drawStart < 0 || drawStart % 3 ||
        !(geometry.drawRange.count === Infinity || Number.isSafeInteger(geometry.drawRange.count) && geometry.drawRange.count >= 0 && geometry.drawRange.count % 3 === 0)) throw new Error("unsupported-rendered-solid-draw-range");
      const material = mesh.material;
      if (geometry.groups.some((g: { start: number; count: number }) => !Number.isSafeInteger(g.start) || !Number.isSafeInteger(g.count) || g.start < 0 || g.count < 0 || g.start % 3 || g.count % 3)) throw new Error("unsupported-rendered-solid-groups");
      const active = (i: number) => Array.isArray(material)
        ? geometry.groups.some((g: { start: number; count: number; materialIndex?: number }) => i >= g.start && i + 2 < g.start + g.count && material[g.materialIndex ?? 0]?.visible)
        : material.visible;
      for (let i = drawStart; i + 2 < drawEnd; i += 3) if (active(i)) {
        for (let k = 0; k < 3; k++) { const n = index ? index.getX(i + k) : i + k; if (!Number.isInteger(n) || n < 0 || n >= attribute.count) throw new Error("invalid-rendered-solid-index"); selected.push(n); }
      }
      const indices = new Uint32Array(selected);
      const instanced = mesh instanceof THREE.InstancedMesh ? mesh : null;
      const count = instanced?.count ?? 1;
      instances += count;
      if (!Number.isSafeInteger(count) || count < 0 || instances > RENDERED_SOLID_LIMITS.instances) throw new Error("rendered-solids-budget");
      if (byteCount + positions.byteLength + indices.byteLength + count * 16 * 8 > RENDERED_SOLID_LIMITS.bytes) throw new Error("rendered-solids-budget");
      const transforms = new Float64Array(count * 16), instance = new THREE.Matrix4(), world = new THREE.Matrix4();
      const writeMatrices = (out: Float64Array) => {
        mesh.updateWorldMatrix(true, false);
        for (let i = 0; i < count; i++) {
          if (instanced) { instanced.getMatrixAt(i, instance); world.multiplyMatrices(mesh.matrixWorld, instance); }
          else world.copy(mesh.matrixWorld);
          out.set(world.elements, i * 16);
        }
      };
      writeMatrices(transforms);
      if (!transforms.every(Number.isFinite)) throw new Error("invalid-rendered-solid-transform");
      byteCount += positions.byteLength + indices.byteLength + transforms.byteLength;
      if (byteCount > RENDERED_SOLID_LIMITS.bytes) throw new Error("rendered-solids-budget");
      const solid = Object.freeze({ id: `rendered:${root.role}:${rootIndex}:${solids.length}`, role: root.role, positions, indices, transforms });
      solids.push(solid);
      const currentMatrices = new Float64Array(transforms.length);
      const groups = JSON.stringify(geometry.groups), range = JSON.stringify(geometry.drawRange);
      checks.push(() => {
        if (lifetime.epoch !== epoch || mesh.geometry !== geometry || geometry.getAttribute("position") !== attribute || geometry.index !== index ||
          mesh.morphTargetInfluences?.some((x) => x !== 0) ||
          (instanced?.count ?? 1) !== count || JSON.stringify(geometry.groups) !== groups || JSON.stringify(geometry.drawRange) !== range || mesh.material !== material) return false;
        for (let i = 0; i < attribute.count; i++) if (attribute.getX(i) !== positions[i*3] || attribute.getY(i) !== positions[i*3+1] || attribute.getZ(i) !== positions[i*3+2]) return false;
        const now: number[] = [];
        for (let i = drawStart; i + 2 < drawEnd; i += 3) if (active(i)) for (let k = 0; k < 3; k++) now.push(index ? index.getX(i+k) : i+k);
        if (now.length !== indices.length || now.some((n, i) => n !== indices[i])) return false;
        writeMatrices(currentMatrices);
        return currentMatrices.every((n, i) => n === transforms[i]);
      });
    });
    checks.push(() => { const current: THREE.Object3D[] = []; root.object.traverse((o) => current.push(o)); return current.length === membership.length && current.every((o, i) => o === membership[i]); });
  }
  return Object.freeze({ solids: Object.freeze(solids), isCurrent: () => checks.every((check) => check()) });
}
