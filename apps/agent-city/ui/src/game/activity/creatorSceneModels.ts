import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { CreatorPublishedMiniGameV1 } from "./creatorMiniGame";
import { inspectGlbBytes, type CityProjectAssetCatalogV1, type SceneDraftV1 } from "@oh-agent/city-sdk";
import { m, METER_MODEL_SCALE } from "../../engine/worldScale";
import { markPreviewEntityObject } from "../../engine/previewEntityRegistry";

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

/** Materialize model objects from a previously verified world-package snapshot. */
export async function loadWorldSceneModels(scene: SceneDraftV1, catalog: CityProjectAssetCatalogV1, files: ReadonlyMap<string, Uint8Array>): Promise<{ group: THREE.Group; dispose(): void }> {
  const models = scene.objects.filter(object => object.kind === "model");
  if (models.length > MAX_RUNTIME_MODELS) throw new Error("creator_scene_model_budget_exceeded");
  const entries = new Map(catalog.entries.map(entry => [entry.assetId, entry]));
  const needed = new Map<string, Uint8Array>();
  for (const model of models) {
    const entry = entries.get(model.asset.assetId);
    const bytes = entry && files.get(entry.relativePath);
    if (!entry || !bytes || entry.sha256 !== model.asset.digest || bytes.length !== entry.byteLength || !inspectGlbBytes(bytes).ok) throw new Error("creator_scene_asset_ref_invalid");
    needed.set(entry.sha256, bytes);
  }
  if (needed.size > MAX_RUNTIME_ASSETS || [...needed.values()].reduce((sum, bytes) => sum + bytes.length, 0) > MAX_RUNTIME_ASSET_BYTES) throw new Error("creator_scene_asset_budget_exceeded");
  const cache = new Map<string, LoadedGltf>();
  const group = new THREE.Group();
  group.name = "creator-world-scene-models";
  try {
    const loader = new GLTFLoader();
    for (const [digest, bytes] of needed) {
      const buffer = Uint8Array.from(bytes).buffer;
      const actual = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
      if (actual !== digest) throw new Error("creator_scene_asset_ref_invalid");
      cache.set(digest, await loader.parseAsync(buffer, ""));
    }
    for (const model of models) {
      const gltf = cache.get(model.asset.digest);
      if (!gltf) throw new Error("creator_scene_asset_ref_invalid");
      const instance = new THREE.Group();
      instance.name = `creator-model-${model.id}`;
      markPreviewEntityObject(instance, { entityId: model.id, label: model.id, kind: "scene-model" });
      const { positionMeters, rotationRadians, scale } = model.transform;
      instance.position.set(m(positionMeters.x), m(positionMeters.y), m(positionMeters.z));
      instance.rotation.set(rotationRadians.x, rotationRadians.y, rotationRadians.z);
      instance.scale.set(scale.x * METER_MODEL_SCALE, scale.y * METER_MODEL_SCALE, scale.z * METER_MODEL_SCALE);
      instance.add(gltf.scene.clone(true));
      group.add(instance);
    }
  } catch (error) { disposeGltfCache(cache); group.clear(); throw error; }
  return { group, dispose() { disposeGltfCache(cache); group.clear(); } };
}

/** Materialize the complete editable scene, including non-model authoring objects. */
export async function loadWorldScenePreview(scene: SceneDraftV1, catalog: CityProjectAssetCatalogV1, files: ReadonlyMap<string, Uint8Array>): Promise<{ group: THREE.Group; dispose(): void }> {
  const loaded = await loadWorldSceneModels(scene, catalog, files);
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const anchorGeometry = new THREE.OctahedronGeometry(m(1));
  const colliderMaterial = new THREE.MeshBasicMaterial({ color: 0x32edb4, wireframe: true, transparent: true, opacity: 0.8 });
  const anchorMaterial = new THREE.MeshBasicMaterial({ color: 0xf4c95d });
  try {
    for (const object of scene.objects) {
      if (object.kind === "model") continue;
      const mesh = new THREE.Mesh(object.kind === "collider" ? boxGeometry : anchorGeometry,
        object.kind === "collider" ? colliderMaterial : anchorMaterial);
      mesh.name = `creator-${object.kind}-${object.id}`;
      const { positionMeters, rotationRadians, scale } = object.transform;
      mesh.position.set(m(positionMeters.x), m(positionMeters.y), m(positionMeters.z));
      mesh.rotation.set(rotationRadians.x, rotationRadians.y, rotationRadians.z);
      if (object.kind === "collider") mesh.scale.set(m(object.sizeMeters.x * scale.x), m(object.sizeMeters.y * scale.y), m(object.sizeMeters.z * scale.z));
      else mesh.scale.set(scale.x, scale.y, scale.z);
      markPreviewEntityObject(mesh, { entityId: object.id, label: object.id,
        kind: object.kind === "collider" ? "scene-collider" : "scene-anchor" });
      loaded.group.add(mesh);
    }
  } catch (error) {
    loaded.dispose();
    boxGeometry.dispose(); anchorGeometry.dispose(); colliderMaterial.dispose(); anchorMaterial.dispose();
    throw error;
  }
  return { group: loaded.group, dispose() {
    loaded.dispose();
    boxGeometry.dispose(); anchorGeometry.dispose(); colliderMaterial.dispose(); anchorMaterial.dispose();
  } };
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
    markPreviewEntityObject(instance, { entityId: item.model.id, label: item.model.id, kind: "scene-model" });
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
