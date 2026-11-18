import * as THREE from "three";
import type { EntitySnapshotV1 } from "../../../../../../packages/city-game-sdk/src/api/types";
import type { RenderPortV1 } from "../../../../../../packages/city-game-sdk/src/host/types";
import type { CodeGameAssetV1 } from "../../../../../../packages/city-game-sdk/src/protocol/manifest";
import { GameSdkError } from "../../../../../../packages/city-game-sdk/src/protocol/errors";
import type {
  CodeGameRenderV1,
  CodeGameSceneLeaseV1,
} from "./codeGameSession";

/**
 * P0 visual ownership for code games. One group is attached to the City scene
 * through the scene lease; every run-owned entity becomes an object inside it.
 *
 * Assets are preloaded once, before the run starts: `spawn()` is synchronous by
 * contract, so a GLB fetch inside it would either block a frame or force the
 * host to expose an async entity API. The loader is injectable so the unit test
 * does not need a browser fetch and the City can later reuse an asset cache.
 *
 * Clones share the template's geometry/material. Disposing per clone would
 * corrupt every other entity built from the same GLB; resources are released
 * once, when the whole render is disposed.
 */

export type CodeGameAssetLoaderV1 = (url: string) => Promise<THREE.Object3D>;

export type ThreeCodeGameRenderOptionsV1 = Readonly<{
  assets: readonly CodeGameAssetV1[];
  /** Absolute base URL; manifest asset paths are workspace-relative. */
  assetBaseUrl: string;
  /** Test seam. Defaults to GLTFLoader over `assetBaseUrl`. */
  loadModel?: CodeGameAssetLoaderV1;
}>;

export async function createThreeCodeGameRender(
  lease: CodeGameSceneLeaseV1<THREE.Object3D>,
  options: ThreeCodeGameRenderOptionsV1,
): Promise<CodeGameRenderV1<THREE.Object3D>> {
  const loader = options.loadModel ?? loadGlb;
  const templates = new Map<string, THREE.Object3D>();
  const models = options.assets.filter((asset) => asset.type === "model/glb");
  await Promise.all(
    models.map(async (asset) => {
      const url = new URL(asset.path, options.assetBaseUrl).href;
      try {
        templates.set(asset.id, await loader(url));
      } catch (error) {
        throw new GameSdkError(
          "game_asset_invalid",
          `Failed to load "${asset.id}" from ${url}: ${error instanceof Error ? error.message : String(error)}`,
          "prepare",
        );
      }
    }),
  );

  const group = new THREE.Group();
  group.name = "code-game";
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    emissive: 0x0369a1,
    emissiveIntensity: 0.9,
    roughness: 0.5,
    metalness: 0.08,
  });
  const meshes = new Map<string, THREE.Object3D>();
  let focus: string | null = null;
  let disposed = false;

  lease.attach([group]);

  // A code game does not own the City's orbit camera. Put the camera behind
  // the first run-owned entity and keep it there while that entity moves, so a
  // preview actually shows the game instead of a distant skyline.
  const follow = (entity: EntitySnapshotV1): void => {
    if (!lease.setCamera) return;
    const [x, y, z] = entity.transform.position;
    lease.setCamera({
      position: [x + 10, y + 7, z + 10],
      target: [x, y, z],
      up: [0, 1, 0],
      fov: 55,
    });
  };

  const apply = (object: THREE.Object3D, entity: EntitySnapshotV1): void => {
    const { position, rotation, scale } = entity.transform;
    object.position.set(position[0], position[1], position[2]);
    if (rotation) object.rotation.set(rotation[0], rotation[1], rotation[2]);
    if (scale) object.scale.set(scale[0], scale[1], scale[2]);
    object.name = entity.id;
  };

  const port: RenderPortV1 = {
    spawn(entity) {
      if (disposed) return;
      const template = templates.get(entity.prefabId);
      const object = template ? template.clone(true) : new THREE.Mesh(geometry, material);
      apply(object, entity);
      group.add(object);
      meshes.set(entity.id, object);
      if (focus === null) {
        focus = entity.id;
        follow(entity);
      }
    },
    update(entity) {
      const object = meshes.get(entity.id);
      if (!object) return;
      apply(object, entity);
      if (entity.id === focus) follow(entity);
    },
    destroy(entityId) {
      const object = meshes.get(entityId);
      if (!object) return;
      group.remove(object);
      meshes.delete(entityId);
      if (focus === entityId) focus = null;
    },
  };

  return Object.freeze({
    port,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const object of meshes.values()) group.remove(object);
      meshes.clear();
      lease.detach([group]);
      group.clear();
      geometry.dispose();
      material.dispose();
      for (const template of templates.values()) disposeObject(template);
      templates.clear();
    },
  });
}

async function loadGlb(url: string): Promise<THREE.Object3D> {
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const gltf = await new GLTFLoader().loadAsync(url);
  return gltf.scene;
}

/** Release template-owned GPU resources exactly once. Clones share them. */
function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) for (const item of material) item.dispose();
    else material?.dispose();
  });
}
