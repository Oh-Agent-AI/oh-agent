import * as THREE from "three";
import { poseMechaModel, type MechaAction } from "../../../../render/mecha/animation";
import { createBoss, createRaider, disposeMechaModel } from "../../../../render/mecha/models";

export type MonsterRigRole = "Boss" | "Raider";
export type MonsterQuality = "rigged" | "core";
export type MonsterCoreStatus = "inactive" | "active" | "unavailable";

/** Presentation samples only; neither this view nor the adapter owns combat state. */
export type MonsterPresentationView = Readonly<{
  action: MechaAction;
  timeSeconds: number;
  reducedMotion?: boolean;
}>;

/** A factory owns its resources, including cleanup if it throws before returning. */
export type MonsterCore = {
  readonly root: THREE.Object3D;
  update?(dt: number, reducedMotion: boolean): void;
  dispose(): void;
};
export type MonsterCoreFactory = (role: MonsterRigRole) => MonsterCore;

export interface MonsterVisualAdapter {
  /** Place, orient and scale this wrapper; the rig keeps its original local transform. */
  readonly root: THREE.Group;
  /** The original, stable animation/GLB-upgrade key and the existing pick target. */
  readonly rigRoot: THREE.Group;
  readonly pickRoot: THREE.Group;
  readonly role: MonsterRigRole;
  readonly faction: "enemy";
  readonly footprint: readonly [number, number];
  readonly quality: MonsterQuality;
  readonly coreStatus: MonsterCoreStatus;
  /** Current world-space bounds of the rig only; the decorative core is excluded. */
  getBounds(target?: THREE.Box3): THREE.Box3;
  update(view: MonsterPresentationView, dt: number): void;
  setQuality(level: MonsterQuality): void;
  dispose(): void;
}

/** A small, optional local-space ornament. It is not a rule or a picking proxy. */
function createLifeCore(role: MonsterRigRole): MonsterCore {
  let geometry: THREE.SphereGeometry | undefined;
  let material: THREE.MeshBasicMaterial | undefined;
  try {
    geometry = new THREE.SphereGeometry(role === "Boss" ? 0.48 : 0.25, 12, 8);
    material = new THREE.MeshBasicMaterial({ color: 0xff718c });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "monster-life-core";
    mesh.position.set(0, role === "Boss" ? 4.5 : 1.85, role === "Boss" ? -6.6 : -3.4);
    mesh.raycast = () => {}; // Never intercept a recursive scene raycast.
    let elapsed = 0;
    let disposed = false;
    return {
      root: mesh,
      update(dt, reducedMotion) {
        if (reducedMotion) { mesh.scale.setScalar(1); return; }
        elapsed += Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
        mesh.scale.setScalar(1 + 0.08 * Math.sin(elapsed * 3));
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        mesh.removeFromParent();
        geometry!.dispose();
        material!.dispose();
      },
    };
  } catch (error) {
    geometry?.dispose();
    material?.dispose();
    throw error;
  }
}

/**
 * Transfer ownership of an unparented existing Boss/Raider rig to the adapter.
 * Its own root, animation registration and asynchronous GLB upgrade stay intact.
 * The core is a sibling, not part of the rig's resource traversal. It follows the
 * rig root, not individual animated bones; this is not a bone-attachment system.
 */
export function wrapMonsterRig(rigRoot: THREE.Group, options: { coreFactory?: MonsterCoreFactory } = {}): MonsterVisualAdapter {
  const role: unknown = rigRoot.userData.role;
  if (role !== "Boss" && role !== "Raider") throw new Error("expected a Boss or Raider rig");
  if (rigRoot.parent) throw new Error("monster rig must be unparented");
  if (rigRoot.userData.disposed) throw new Error("monster rig is already disposed");

  const root = new THREE.Group();
  root.name = "monster-visual";
  const coreMount = new THREE.Group();
  coreMount.name = "monster-core-mount";
  root.add(rigRoot);
  let core: MonsterCore | undefined;
  let quality: MonsterQuality = "rigged";
  let coreStatus: MonsterCoreStatus = "inactive";
  let disposed = false;

  function requireLive(): void {
    if (disposed) throw new Error("monster visual is disposed");
  }
  function syncCoreTransform(): void {
    coreMount.position.copy(rigRoot.position);
    coreMount.quaternion.copy(rigRoot.quaternion);
    coreMount.scale.copy(rigRoot.scale);
  }
  function releaseCore(): void {
    const previous = core;
    core = undefined;
    coreMount.removeFromParent();
    if (previous) {
      previous.root.removeFromParent();
      previous.dispose();
    }
  }

  return {
    root, rigRoot, pickRoot: rigRoot, role, faction: "enemy",
    footprint: role === "Boss" ? [2, 2] : [1, 1],
    get quality() { return quality; },
    get coreStatus() { return coreStatus; },
    getBounds(target = new THREE.Box3()) {
      requireLive();
      rigRoot.updateWorldMatrix(true, true);
      return target.setFromObject(rigRoot);
    },
    update(view, dt) {
      requireLive();
      poseMechaModel(rigRoot, view.action, view.timeSeconds, view.reducedMotion ?? false);
      if (core) {
        syncCoreTransform();
        try {
          core.update?.(dt, view.reducedMotion ?? false);
        } catch {
          try { releaseCore(); } catch { /* A broken ornament must not take down the rig. */ }
          quality = "rigged";
          coreStatus = "unavailable";
        }
      }
    },
    setQuality(level) {
      requireLive();
      if (level === "rigged") {
        quality = "rigged";
        coreStatus = "inactive";
        releaseCore();
        return;
      }
      if (level !== "core") throw new Error("unknown monster quality");
      if (core) return;
      let candidate: MonsterCore | undefined;
      try {
        candidate = (options.coreFactory ?? createLifeCore)(role);
        if (candidate.root.parent) throw new Error("monster core must be unparented");
        // Only the rig is interactive, including for recursive scene raycasts.
        candidate.root.traverse((node) => { node.raycast = () => {}; });
        syncCoreTransform();
        coreMount.add(candidate.root);
        root.add(coreMount);
        core = candidate;
        quality = "core";
        coreStatus = "active";
      } catch {
        coreMount.removeFromParent();
        if (candidate && candidate.root.parent === coreMount) candidate.root.removeFromParent();
        try { candidate?.dispose(); } catch { /* Keep the rig usable even if optional cleanup fails. */ }
        quality = "rigged";
        coreStatus = "unavailable";
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      quality = "rigged";
      coreStatus = "inactive";
      try {
        releaseCore();
      } finally {
        try { disposeMechaModel(rigRoot); } finally { root.removeFromParent(); }
      }
    },
  };
}

/** Create the existing procedural/GLB-upgradeable model with no enhancement enabled. */
export function createMonsterVisual(role: MonsterRigRole, options: { coreFactory?: MonsterCoreFactory } = {}): MonsterVisualAdapter {
  if (role !== "Boss" && role !== "Raider") throw new Error("unknown monster rig role");
  return wrapMonsterRig(role === "Boss" ? createBoss() : createRaider(), options);
}
