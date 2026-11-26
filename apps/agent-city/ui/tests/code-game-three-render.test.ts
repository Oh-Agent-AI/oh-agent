import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { EntitySnapshotV1 } from "../../../../packages/city-game-sdk/src/api/types.ts";
import type { CodeGameCameraPoseV1, CodeGameSceneLeaseV1 } from "../src/game/codeGameHost/codeGameSession.ts";
import { createThreeCodeGameRender } from "../src/game/codeGameHost/threeRenderPort.ts";
import { GameSdkError } from "../../../../packages/city-game-sdk/src/protocol/errors.ts";

/**
 * The render port is the only Three-aware piece of the code-game host. Its
 * contract is small but load-bearing: manifest GLBs are preloaded once, each
 * entity gets a clone that shares template geometry, and dispose detaches the
 * group exactly once. A leak here is a ghost object in the City after exit.
 */

const entity = (id: string, position: readonly [number, number, number]): EntitySnapshotV1 =>
  Object.freeze({
    id,
    prefabId: "cube",
    transform: Object.freeze({ position }),
    props: Object.freeze({}),
  });

function createLease(): {
  lease: CodeGameSceneLeaseV1<THREE.Object3D>;
  attached: THREE.Object3D[];
  detached: THREE.Object3D[];
  cameras: CodeGameCameraPoseV1[];
} {
  const attached: THREE.Object3D[] = [];
  const detached: THREE.Object3D[] = [];
  const cameras: CodeGameCameraPoseV1[] = [];
  return {
    attached,
    detached,
    cameras,
    lease: {
      token: Symbol("scene"),
      isCurrent: () => true,
      setFrameHook: () => undefined,
      attach: (objects) => attached.push(...objects),
      detach: (objects) => detached.push(...objects),
      setCamera: (pose) => cameras.push(pose),
      release: () => undefined,
    },
  };
}

const cubeLoader = (loaded: string[]) => async (url: string): Promise<THREE.Object3D> => {
  loaded.push(url);
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  return group;
};

test("declared GLB assets are preloaded and cloned per entity", async () => {
  const { lease, attached, cameras } = createLease();
  const loaded: string[] = [];
  const render = await createThreeCodeGameRender(lease, {
    assets: [{ id: "cube", path: "assets/cube.glb", type: "model/glb" }],
    assetBaseUrl: "https://example.test/code-games/",
    loadModel: cubeLoader(loaded),
  });
  assert.deepEqual(loaded, ["https://example.test/code-games/assets/cube.glb"]);
  assert.equal(attached.length, 1);
  const group = attached[0] as THREE.Group;

  render.port.spawn(entity("e1", [1, 2, 3]));
  render.port.spawn(entity("e2", [4, 5, 6]));
  const first = group.children[0] as THREE.Group;
  const second = group.children[1] as THREE.Group;
  assert.equal(group.children.length, 2);
  assert.equal(first.position.x, 1);
  assert.equal(second.position.x, 4);
  const firstMesh = first.children[0] as THREE.Mesh;
  const secondMesh = second.children[0] as THREE.Mesh;
  assert.notEqual(firstMesh, secondMesh, "each entity gets its own clone");
  assert.equal(firstMesh.geometry, secondMesh.geometry, "clones share template geometry");

  assert.equal(cameras.length, 1, "the camera follows the first run-owned entity");
  assert.deepEqual(cameras[0]?.target, [1, 2, 3]);

  render.port.update(entity("e1", [7, 8, 9]));
  assert.equal(first.position.x, 7);
  assert.deepEqual(cameras[cameras.length - 1]?.target, [7, 8, 9], "the camera follows the moving entity");

  render.port.destroy("e1");
  assert.equal(group.children.length, 1);
  render.port.destroy("e1");
  render.port.destroy("missing");
  assert.equal(group.children.length, 1);

  render.dispose();
  assert.equal(group.children.length, 0);
});

test("an entity whose prefab was not declared still renders as a placeholder", async () => {
  const { lease, attached } = createLease();
  const render = await createThreeCodeGameRender(lease, { assets: [], assetBaseUrl: "https://example.test/" });
  const group = attached[0] as THREE.Group;
  render.port.spawn(entity("e1", [0, 0, 0]));
  assert.equal(group.children[0] instanceof THREE.Mesh, true);
  render.dispose();
});

test("a failing GLB load fails the run with game_asset_invalid", async () => {
  const { lease } = createLease();
  await assert.rejects(
    createThreeCodeGameRender(lease, {
      assets: [{ id: "cube", path: "assets/missing.glb", type: "model/glb" }],
      assetBaseUrl: "https://example.test/",
      loadModel: async () => {
        throw new Error("404");
      },
    }),
    (error) => {
      assert.equal(error instanceof GameSdkError, true);
      assert.equal((error as GameSdkError).code, "game_asset_invalid");
      return true;
    },
  );
});

test("dispose detaches exactly once and ignores later calls", async () => {
  const { lease, detached } = createLease();
  const render = await createThreeCodeGameRender(lease, { assets: [], assetBaseUrl: "https://example.test/" });
  render.port.spawn(entity("e1", [0, 0, 0]));

  render.dispose();
  render.dispose();
  assert.equal(detached.length, 1);

  render.port.spawn(entity("e2", [0, 0, 0]));
  assert.equal(detached.length, 1, "a disposed renderer must not create new meshes");
});

test("sealed asset mode never falls back to a workspace URL", async () => {
  const { lease } = createLease();
  const loaded: string[] = [];
  await assert.rejects(createThreeCodeGameRender(lease, {
    assets: [{ id: "cube", path: "assets/cube.glb", type: "model/glb" }],
    assetBaseUrl: "https://example.test/workspace/",
    assetBytes: {},
    loadModel: cubeLoader(loaded),
  }), /sealed asset bytes are missing/);
  assert.deepEqual(loaded, []);
});
