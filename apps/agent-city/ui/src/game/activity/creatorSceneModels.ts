import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { CreatorPublishedMiniGameV1 } from "./creatorMiniGame";
import { m, METER_MODEL_SCALE } from "../../engine/worldScale";

const MAX_RUNTIME_MODELS = 512;
const MAX_RUNTIME_ASSETS = 32;
const MAX_RUNTIME_ASSET_BYTES = 256 * 1024 * 1024;

type LoadedGltf = Awaited<ReturnType<GLTFLoader["loadAsync"]>>;

function assetUrl(releaseId: string, digest: string): string {
  if (!/^release-[a-f0-9]{32}$/.test(releaseId) || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("creator_scene_asset_ref_invalid");
  return `ohcityasset://localhost/v1/${releaseId}/${digest.slice("sha256:".length)}.glb`;
}

function disposeGltfCache(cache: ReadonlyMap<string, LoadedGltf>): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const gltf of cache.values()) gltf.scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const list = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of list) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  textures.forEach(texture => texture.dispose());
  materials.forEach(material => material.dispose());
  geometries.forEach(geometry => geometry.dispose());
}

/** Loads only published, already-validated project assets through the local City-scoped protocol. */
export async function loadCreatorSceneModels(experiences: readonly CreatorPublishedMiniGameV1[]): Promise<{
  group: THREE.Group;
  dispose(): void;
  skippedModels: number;
}> {
  const group = new THREE.Group();
  group.name = "creator-published-scene-models";
  const cache = new Map<string, LoadedGltf>();
  const pending: Array<{ releaseId: string; model: Extract<NonNullable<CreatorPublishedMiniGameV1["scenePackage"]>["scene"]["objects"][number], { kind: "model" }> }> = [];
  const byteLengthByKey = new Map<string, number>();
  const seenReleases = new Set<string>();
  for (const experience of experiences) {
    const bundle = experience.scenePackage;
    if (!bundle || seenReleases.has(experience.releaseId)) continue;
    seenReleases.add(experience.releaseId);
    const entries = new Map(bundle.assets.entries.map(entry => [entry.assetId, entry]));
    for (const object of bundle.scene.objects) {
      if (object.kind !== "model") continue;
      const entry = entries.get(object.asset.assetId);
      if (!entry || entry.sha256 !== object.asset.digest) continue;
      const key = `${experience.releaseId}:${entry.sha256}`;
      if (!byteLengthByKey.has(key)) byteLengthByKey.set(key, entry.byteLength);
      pending.push({ releaseId: experience.releaseId, model: object });
      if (pending.length > MAX_RUNTIME_MODELS) throw new Error("creator_scene_model_budget_exceeded");
    }
  }
  if (byteLengthByKey.size > MAX_RUNTIME_ASSETS
      || [...byteLengthByKey.values()].reduce((total, length) => total + length, 0) > MAX_RUNTIME_ASSET_BYTES) {
    throw new Error("creator_scene_asset_budget_exceeded");
  }
  let skippedModels = 0;
  const loader = new GLTFLoader();
  for (const item of pending) {
    const reference = item.model.asset;
    const key = `${item.releaseId}:${reference.digest}`;
    let gltf = cache.get(key);
    if (!gltf) {
      try {
        gltf = await loader.loadAsync(assetUrl(item.releaseId, reference.digest));
        cache.set(key, gltf);
      } catch {
        skippedModels += 1;
        continue;
      }
    }
    const instance = new THREE.Group();
    instance.name = `creator-model-${item.model.id}`;
    const { positionMeters, rotationRadians, scale } = item.model.transform;
    instance.position.set(m(positionMeters.x), m(positionMeters.y), m(positionMeters.z));
    instance.rotation.set(rotationRadians.x, rotationRadians.y, rotationRadians.z);
    instance.scale.set(scale.x * METER_MODEL_SCALE, scale.y * METER_MODEL_SCALE, scale.z * METER_MODEL_SCALE);
    instance.add(gltf.scene.clone(true));
    group.add(instance);
  }
  return {
    group,
    skippedModels,
    dispose() {
      disposeGltfCache(cache);
      group.clear();
    },
  };
}
