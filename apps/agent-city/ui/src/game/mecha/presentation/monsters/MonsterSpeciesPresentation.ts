import * as THREE from "three";
import { createMonsterSpeciesOrnament, isMonsterSpeciesDesign } from "../../../../render/mecha/monsterSpeciesOrnaments";
import { createLegacyBossOrnament } from "../../../../render/mecha/legacyBossOrnament";
import type { MonsterCore, MonsterCoreFactory, MonsterRigRole } from "./MonsterVisualAdapter";
import { applyMechaUnitLight } from "../../../../render/mecha/unitLight";

export type MonsterSpeciesVisualStatus = "active" | "disabled" | "legacy" | "unavailable" | "disposed";
export type MonsterSpeciesVisual = {
  /** Presentation sibling of the rig; never a rule target. */
  readonly root: THREE.Group;
  /** Raycast this sibling recursively as an additional rig hit target while active. */
  readonly pickRoot: THREE.Group | null;
  readonly status: MonsterSpeciesVisualStatus;
  /** Call after the rig's placement/rotation/visibility is updated, before rendering. */
  update(dt: number, reducedMotion?: boolean, health?: { hp: number; maxHp: number }): void;
  /** Off restores the original rig materials; on retries creation. */
  setEnabled(enabled: boolean): void;
  /** Release before or alongside disposeMechaModel(rig); does not own the rig. */
  dispose(): void;
};

/** Optional factory for the existing wrapMonsterRig/createMonsterVisual core path. */
export function createMonsterSpeciesCoreFactory(speciesId: string): MonsterCoreFactory {
  return (role) => createMonsterSpeciesOrnament(speciesId, role);
}

/**
 * Replace the visible body of an existing Boss/Raider without reparenting the
 * rig or taking ownership. The rig stays visible to the City picking traversal;
 * only its per-mesh material references are temporarily replaced. A Boss with
 * `legacy_boss` (or undefined) gets a separate default geometric body, not a
 * species; unrecognized identifiers and factory failures fall back to the rig.
 * The optional factory owns/cleans any resources allocated before it throws.
 */
export function createMonsterSpeciesPresentation(
  rigRoot: THREE.Group,
  speciesId?: string,
  options: { ornamentFactory?: (id: string, role: MonsterRigRole) => MonsterCore; legacyFactory?: () => MonsterCore; visualScale?: number } = {},
): MonsterSpeciesVisual {
  const root = new THREE.Group();
  root.name = "monster-species-presentation";
  let status: MonsterSpeciesVisualStatus = "disabled";
  let ornament: MonsterCore | undefined;
  let disposed = false;
  const poseMatrix = new THREE.Matrix4(), poseScale = new THREE.Vector3();
  type MaterialSet = THREE.Material | THREE.Material[];
  const masked = new Map<THREE.Mesh, { original: MaterialSet; replacement: MaterialSet }>();
  const invisible = new Map<THREE.Material, THREE.Material>();

  function hidden(original: THREE.Material): THREE.Material {
    let replacement = invisible.get(original);
    if (!replacement) {
      // Mesh.raycast reads side but not material.visible. Never mutate a shared GLB material.
      replacement = new THREE.MeshBasicMaterial({ visible: false, side: original.side });
      invisible.set(original, replacement);
    }
    return replacement;
  }
  function maskRig(): void {
    // The city normally patches the rig for night lighting. Ensure that patch is
    // on the originals as well, since its frame hook will see our hidden materials.
    applyMechaUnitLight(rigRoot);
    const live = new Set<THREE.Mesh>();
    rigRoot.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      live.add(node);
      const previous = masked.get(node);
      if (previous && node.material === previous.replacement) return;
      const original = node.material;
      const replacement = Array.isArray(original) ? original.map(hidden) : hidden(original);
      masked.set(node, { original, replacement });
      node.material = replacement;
    });
    for (const [mesh, entry] of masked) {
      if (live.has(mesh)) continue;
      if (mesh.material === entry.replacement) mesh.material = entry.original;
      masked.delete(mesh);
    }
  }
  function restoreRig(): void {
    for (const [mesh, entry] of masked) if (mesh.material === entry.replacement) mesh.material = entry.original;
    masked.clear();
    for (const material of invisible.values()) {
      try { material.dispose(); } catch { /* A third-party dispose listener must not block restoration. */ }
    }
    invisible.clear();
  }
  // A GLB upgrade replaces the root's direct child synchronously. Mask it in
  // the same event, not merely on the next frame, including while frames pause.
  function onRigChildAdded(): void {
    if (!ornament || disposed) return;
    try { maskRig(); } catch {
      try { release(); } catch { /* Keep the model available even if cleanup fails. */ }
      status = "unavailable";
    }
  }
  function release(): void {
    const previous = ornament;
    ornament = undefined;
    rigRoot.removeEventListener("childadded", onRigChildAdded);
    restoreRig();
    root.removeFromParent();
    if (previous) {
      if (previous.root.parent === root) previous.root.removeFromParent();
      previous.dispose();
    }
  }
  function sync(): void {
    if (!rigRoot.parent || !ornament) { root.removeFromParent(); return; }
    if (root.parent !== rigRoot.parent) rigRoot.parent.add(root);
    root.position.copy(rigRoot.position);
    root.quaternion.copy(rigRoot.quaternion);
    root.scale.copy(rigRoot.scale);
    root.visible = rigRoot.visible;
    // The sibling follows placement, but the original defeat pose lives inside
    // the rig. Transfer that pose to the legacy body without inheriting GLB
    // unit scaling or relying on a node that may be replaced by a late upgrade.
    // Species bodies need the same defeat pose as the hidden rig.
    {
      const pose = rigRoot.userData.glb ? rigRoot.getObjectByName("visual") : rigRoot.userData.proceduralVisual;
      if (pose instanceof THREE.Object3D) {
        pose.updateWorldMatrix(true, false);
        poseMatrix.copy(rigRoot.matrixWorld).invert().multiply(pose.matrixWorld);
        poseMatrix.decompose(ornament.root.position, ornament.root.quaternion, poseScale);
      } else {
        ornament.root.position.set(0, 0, 0);
        ornament.root.quaternion.identity();
      }
    }
  }
  function enable(): void {
    if (disposed) throw new Error("monster species visual is disposed");
    if (ornament) return;
    const legacy = speciesId === undefined || speciesId === "legacy_boss";
    const role: unknown = rigRoot.userData.role;
    if (legacy && role === "Raider" && !rigRoot.userData.disposed) { status = "legacy"; return; }
    if ((legacy ? role !== "Boss" : !isMonsterSpeciesDesign(speciesId) || (role !== "Boss" && role !== "Raider")) || rigRoot.userData.disposed) {
      status = "unavailable";
      return;
    }
    let candidate: MonsterCore | undefined;
    try {
      candidate = legacy
        ? (options.legacyFactory ?? createLegacyBossOrnament)()
        : (options.ornamentFactory ?? createMonsterSpeciesOrnament)(speciesId!, role as MonsterRigRole);
      if (!(candidate.root instanceof THREE.Object3D) || candidate.root.parent) throw new Error("monster ornament must be an unparented Object3D");
      let meshes = 0;
      candidate.root.traverse((node) => { if (node instanceof THREE.Mesh) meshes++; });
      if (!meshes) throw new Error("monster body must contain a mesh");
      if (!legacy && Number.isFinite(options.visualScale) && options.visualScale! > 0) { candidate.root.scale.x *= options.visualScale!; candidate.root.scale.z *= options.visualScale!; }
      root.add(candidate.root);
      ornament = candidate;
      maskRig();
      rigRoot.addEventListener("childadded", onRigChildAdded);
      sync();
      status = legacy ? "legacy" : "active";
    } catch {
      rigRoot.removeEventListener("childadded", onRigChildAdded);
      restoreRig();
      if (candidate?.root?.parent === root) candidate.root.removeFromParent();
      try { candidate?.dispose(); } catch { /* Optional body must not take down the rig. */ }
      ornament = undefined;
      root.removeFromParent();
      status = "unavailable";
    }
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try { release(); } catch { /* The non-owning rig must survive optional cleanup failure. */ }
    status = "disposed";
  }
  enable();
  return {
    root,
    get pickRoot() { return ornament ? root : null; },
    get status() { return status; },
    update(dt, reducedMotion = false, health) {
      if (disposed) throw new Error("monster species visual is disposed");
      if (rigRoot.userData.disposed) { dispose(); return; }
      if (!ornament) return;
      try {
        maskRig();
        sync();
        ornament.update?.(dt, reducedMotion);
        // Modulate the animated baseline only when valid displayed health exists.
        if (health && Number.isFinite(health.hp) && Number.isFinite(health.maxHp) && health.maxHp > 0) {
          const ratio = Math.max(0, Math.min(1, health.hp / health.maxHp));
          const light = ornament.root.getObjectByName("monster-fx-light");
          if (light instanceof THREE.PointLight) light.intensity *= .35 + .65 * ratio;
        }
      } catch {
        try { release(); } catch { /* Keep the rig usable on ornament failure. */ }
        status = "unavailable";
      }
    },
    setEnabled(enabled) {
      if (disposed) throw new Error("monster species visual is disposed");
      if (enabled) { enable(); return; }
      try { release(); } catch { /* The non-owning rig must survive optional cleanup failure. */ }
      status = "disabled";
    },
    dispose,
  };
}
