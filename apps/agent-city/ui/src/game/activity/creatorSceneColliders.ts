import * as THREE from "three";
import type { SceneBoxColliderObjectV1 } from "@agent-vitals/city-sdk";
import type { SolidInput } from "../driving/CollisionIndex";
import type { CreatorPublishedMiniGameV1 } from "./creatorMiniGame";
import { m } from "../../engine/worldScale";

const MAX_CREATOR_COLLIDERS_PER_RELEASE = 64;
const ROLE = "creator-static-obstacle";

/** Converts explicit, validated box colliders to City world units for one mounted release. */
export function compileCreatorSceneColliders(experience: CreatorPublishedMiniGameV1): Readonly<{ revision: string; solids: readonly SolidInput[] }> {
  if (!/^release-[a-f0-9]{32}$/.test(experience.releaseId)) throw new Error("creator_release_id_invalid");
  const objects = experience.scenePackage?.scene.objects.filter((object): object is SceneBoxColliderObjectV1 => object.kind === "collider") ?? [];
  if (objects.length > MAX_CREATOR_COLLIDERS_PER_RELEASE) throw new Error("creator_scene_collider_budget_exceeded");
  const solids = objects.map((object): SolidInput => {
    const { positionMeters, rotationRadians, scale } = object.transform;
    const { x, y, z } = object.sizeMeters;
    if (![positionMeters.x, positionMeters.y, positionMeters.z, rotationRadians.x, rotationRadians.y, rotationRadians.z,
      scale.x, scale.y, scale.z, x, y, z].every(Number.isFinite)
      || [scale.x, scale.y, scale.z, x, y, z].some(value => value <= 0)) throw new Error("creator_scene_collider_invalid");
    const rotation = new THREE.Euler(rotationRadians.x, rotationRadians.y, rotationRadians.z, "XYZ");
    const axis = (direction: THREE.Vector3, extent: number) => {
      const value = direction.applyEuler(rotation).multiplyScalar(m(extent));
      return Object.freeze({ x: value.x, y: value.y, z: value.z });
    };
    return Object.freeze({ id: `creator:${experience.releaseId}:${object.id}`, role: ROLE, kind: "box",
      center: Object.freeze({ x: m(positionMeters.x), y: m(positionMeters.y), z: m(positionMeters.z) }),
      halfAxes: Object.freeze([
        axis(new THREE.Vector3(1, 0, 0), x * scale.x / 2),
        axis(new THREE.Vector3(0, 1, 0), y * scale.y / 2),
        axis(new THREE.Vector3(0, 0, 1), z * scale.z / 2),
      ]) as unknown as readonly [Readonly<{ x: number; y: number; z: number }>, Readonly<{ x: number; y: number; z: number }>, Readonly<{ x: number; y: number; z: number }>],
    });
  });
  return Object.freeze({ revision: experience.releaseId, solids: Object.freeze(solids) });
}
