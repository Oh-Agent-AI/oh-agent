import * as THREE from "three";
import { MechaPerformancePlayer, type MechaPerformanceOverride } from "./animation";
import { createAssaultPerformancePlan } from "./assaultPerformance";
import { createAssaultPerformanceOverride, type AssaultPreviewGround } from "./assaultPerformanceOverride";
import { measureAssaultStride } from "./assaultStride";
import { getMechaGlbAsset, holdMechaGlbUpgrade } from "./models";
import type { MechaPerformanceEvent } from "./performance";

export const ASSAULT_STRIDE_MULTIPLIER = 6;
export const ASSAULT_WALK_IK_MAX_FACTOR = 3;
export const ASSAULT_WALK_CYCLE_SECONDS = .48;
export const ASSAULT_TRANSITION_SECONDS = .7;
// Blend in steady travel to avoid brief body stalls in the source clip.
export const fastAssaultStrideProfile = (profile: (phase: number) => number) =>
  (phase: number) => profile(phase) * .1 + phase * .9;
export const assaultTurnDuration = (delta: number) => Math.max(.24, (Math.ceil(Math.abs(delta) / (Math.PI / 12)) + 1) * .24);

type Actors = Record<string, THREE.Group>;
type CellToWorld = (cell: { x: number; y: number }, actor: string) => THREE.Vector3;

export function createConnectedAssaultPreviewPlayer(
  actors: Actors, events: MechaPerformanceEvent[], cellToWorld: CellToWorld, effectRoot: THREE.Object3D, onComplete: () => void,
  ground?: Omit<AssaultPreviewGround, "asset">, initiallyFallen: readonly string[] = [],
): { player: MechaPerformancePlayer; release: () => void } {
  const assault = actors.Assault;
  if (!assault) throw new Error("missing Assault actor");
  const release = holdMechaGlbUpgrade(assault);
  try {
    let override: MechaPerformanceOverride | undefined;
    const asset = getMechaGlbAsset(assault);
    if (ground && asset?.manifest.id !== "assault-connected-candidate") throw new Error("connected Assault candidate is not ready");
    if (asset?.manifest.id === "assault-connected-candidate") {
      try {
        const scale = assault.scale;
        if (scale.x <= 0 || Math.abs(scale.x - scale.y) > 1e-6 || Math.abs(scale.x - scale.z) > 1e-6) throw new Error("invalid Assault scale");
        assault.updateWorldMatrix(true, false);
        const worldScale = assault.getWorldScale(new THREE.Vector3());
        if (worldScale.x <= 0 || Math.abs(worldScale.x - worldScale.y) > 1e-6 || Math.abs(worldScale.x - worldScale.z) > 1e-6) throw new Error("invalid Assault world scale");
        const measured = measureAssaultStride(asset);
        // The body moves up to six clip strides per cycle for snappier gameplay.
        // Leg retargeting is capped at three so the extra distance produces controlled
        // foot slip instead of asking the IK solver to exceed the model's reach.
        const baseStride = measured.stride * scale.x;
        const plan = createAssaultPerformancePlan(events, "Assault", assault.rotation.y, cellToWorld, baseStride * ASSAULT_STRIDE_MULTIPLIER, ASSAULT_WALK_CYCLE_SECONDS, assaultTurnDuration, ground ? ASSAULT_TRANSITION_SECONDS : 0);
        const unitScale = 21.245691361301702 / 2 * worldScale.x;
        override = createAssaultPerformanceOverride(assault, plan, fastAssaultStrideProfile(measured.profile), asset.manifest.clips.move!.duration, { crouch: .012 * unitScale, lift: .022 * unitScale }, ground ? { ...ground, asset } : undefined, initiallyFallen.includes("Assault"), { baseStride, toeStartZ: measured.toeStartZ, maxFactor: ASSAULT_WALK_IK_MAX_FACTOR });
      } catch (error) {
        if (ground) throw error;
        console.warn("[mecha] connected Assault preview unavailable, using standard playback:", error);
      }
    }
    return { player: new MechaPerformancePlayer(actors, events, cellToWorld, effectRoot, onComplete, override, initiallyFallen), release };
  } catch (error) {
    release();
    throw error;
  }
}
