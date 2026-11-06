/**
 * Compile a session-kit/v1 overlay onto a session parcel and drive block-by-block
 * construction. Geometry goes through buildingCompiler (same Part alphabet as landmarks).
 */
import * as THREE from "three";
import { compileBuilding, type CompileTarget } from "./render/buildingCompiler";
import { createMaterialFactory } from "./render/landmarkMaterials";
import type { BuildingPlan, Part, PartRole } from "./models/model";
import type { BuildingRuntime } from "./render/types";
import {
  constructionOrder, partReveal, type KitPart, type KitRole, type OverlayDecision,
} from "./sessionKitConstruction";
import {
  editPresentation, GHOST_OPACITY, type EditVisual, type GhostVisual, type RejectVisual,
} from "./sessionKitEditState";
import type { ClaimTint } from "./squadEvents";

export type KitRuntime = {
  decision: OverlayDecision;
  group: THREE.Group;
  objects: THREE.Object3D[];
  progress: number;
  disposables: Array<{ dispose: () => void }>;
};

const ROLE_TINT: Record<string, string> = {
  wall: "#c47a54",
  structure: "#9a6a4a",
  roof: "#7a3e32",
  glass: "#73b8c0",
  trim: "#e8d5a3",
  door: "#5a4030",
  window: "#8ec8d0",
};

const FLASH_COLOR = "#e24b4b";
const CLAIM_COLOR = "#f0c14b";
export const CLAIM_OPACITY = 0.22;

function compileRole(role: KitRole): PartRole {
  if (role === "door") return "structure";
  if (role === "window") return "glass";
  return role;
}

function planFrom(parts: KitPart[], palette?: string): BuildingPlan {
  return constructionOrder(parts).map((part) => {
    const mapped: Part = {
      id: part.id,
      kind: part.kind,
      role: compileRole(part.role),
      at: part.at,
      size: part.size,
      color: part.color ?? palette ?? ROLE_TINT[part.role] ?? ROLE_TINT.wall,
      ...(part.rot ? { rot: part.rot } : {}),
    };
    return mapped;
  });
}

export function createKitRuntime(decision: OverlayDecision, runtime: BuildingRuntime, palette?: string): KitRuntime {
  const group = new THREE.Group();
  group.name = `session-kit:${decision.assetRef}`;
  group.position.set(runtime.slot.x, runtime.groundY, runtime.slot.z);
  group.rotation.y = runtime.slot.yaw;
  const disposables: Array<{ dispose: () => void }> = [];
  const material = createMaterialFactory((item) => disposables.push(item));
  const objects: THREE.Object3D[] = [];
  const target: CompileTarget = {
    group,
    material,
    disposables,
    onPart: (_part, object) => { objects.push(object); },
  };
  if (decision.parts.length) compileBuilding(planFrom(decision.parts, palette), target);
  const progress = decision.animate ? 0 : 1;
  applyKitProgress(objects, progress, decision.parts.length);
  group.visible = decision.kind === "set";
  return { decision, group, objects, progress, disposables };
}

export function applyKitProgress(objects: THREE.Object3D[], progress: number, partCount: number): void {
  const count = objects.length || partCount;
  for (let index = 0; index < objects.length; index += 1) {
    const reveal = partReveal(progress, index, count);
    const object = objects[index];
    object.visible = reveal > 0.001;
    object.scale.set(1, Math.max(0.001, reveal), 1);
  }
}

export function stepKitRuntime(kit: KitRuntime, dt: number): boolean {
  const target = kit.decision.kind === "reset" ? 0 : 1;
  if (!kit.decision.animate) {
    if (kit.progress === target) return false;
    kit.progress = target;
    applyKitProgress(kit.objects, kit.progress, kit.decision.parts.length);
    kit.group.visible = kit.decision.kind === "set";
    return true;
  }
  if (Math.abs(kit.progress - target) < 0.002) {
    if (kit.progress === target) return false;
    kit.progress = target;
    applyKitProgress(kit.objects, kit.progress, kit.decision.parts.length);
    kit.group.visible = kit.decision.kind === "set" && target > 0;
    return true;
  }
  const rate = Math.min(1, dt * 1.15);
  kit.progress += (target - kit.progress) * rate;
  applyKitProgress(kit.objects, kit.progress, kit.decision.parts.length);
  kit.group.visible = kit.decision.kind === "set" || kit.progress > 0.002;
  return true;
}

export function disposeKitRuntime(kit: KitRuntime): void {
  kit.group.removeFromParent();
  for (const disposable of kit.disposables) disposable.dispose();
}

export function replayKitRuntime(kit: KitRuntime): void {
  kit.decision = { ...kit.decision, animate: true };
  kit.progress = 0;
  kit.group.visible = kit.decision.kind === "set";
  applyKitProgress(kit.objects, 0, kit.decision.parts.length);
}

export type EditRuntime = {
  visual: EditVisual;
  group: THREE.Group;
  objects: THREE.Object3D[];
  disposables: Array<{ dispose: () => void }>;
  lastOpacity: number;
};

function ghostMaterialFactory(onCreate: (item: { dispose: () => void }) => void): ReturnType<typeof createMaterialFactory> {
  const inner = createMaterialFactory((item) => onCreate(item));
  return (color, emissive, options) => {
    const material = inner(color, emissive, { ...options, private: true });
    material.transparent = true;
    material.opacity = GHOST_OPACITY;
    material.depthWrite = false;
    return material;
  };
}

export function createGhostRuntime(visual: GhostVisual, runtime: BuildingRuntime, palette?: string): EditRuntime {
  const group = new THREE.Group();
  group.name = `session-kit-ghost:${visual.assetRef}`;
  group.position.set(runtime.slot.x, runtime.groundY, runtime.slot.z);
  group.rotation.y = runtime.slot.yaw;
  const disposables: Array<{ dispose: () => void }> = [];
  const objects: THREE.Object3D[] = [];
  const target: CompileTarget = {
    group,
    material: ghostMaterialFactory((item) => disposables.push(item)),
    disposables,
    onPart: (_part, object) => { objects.push(object); },
  };
  if (visual.parts.length) compileBuilding(planFrom(visual.parts, palette), target);
  applyKitProgress(objects, 1, visual.parts.length);
  group.visible = visual.parts.length > 0;
  return { visual, group, objects, disposables, lastOpacity: GHOST_OPACITY };
}

export function createFlashRuntime(visual: RejectVisual, runtime: BuildingRuntime): EditRuntime {
  const group = new THREE.Group();
  group.name = `session-kit-flash:${visual.assetRef}`;
  group.position.set(runtime.slot.x, runtime.groundY, runtime.slot.z);
  group.rotation.y = runtime.slot.yaw;
  const height = Math.max(2.2, runtime.building.height * Math.max(runtime.display, 0.4));
  const geometry = new THREE.BoxGeometry(runtime.slot.width * 0.94, height, runtime.slot.depth * 0.94);
  const material = new THREE.MeshBasicMaterial({
    color: FLASH_COLOR, transparent: true, opacity: 0.55, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = height / 2;
  group.add(mesh);
  return {
    visual,
    group,
    objects: [mesh],
    disposables: [geometry, material],
    lastOpacity: 0.55,
  };
}

export function createEditRuntime(visual: EditVisual, runtime: BuildingRuntime, palette?: string): EditRuntime | null {
  if (visual.kind === "ghost") return createGhostRuntime(visual, runtime, palette);
  return createFlashRuntime(visual, runtime);
}

export function stepEditRuntime(edit: EditRuntime, nowMs: number): boolean {
  const shown = editPresentation(edit.visual, nowMs);
  if (edit.lastOpacity === shown.opacity && edit.group.visible === shown.active) return false;
  edit.lastOpacity = shown.opacity;
  edit.group.visible = shown.active;
  for (const object of edit.objects) {
    object.traverse((node) => {
      const material = (node as THREE.Mesh).material;
      if (material && "opacity" in material) {
        (material as THREE.MeshBasicMaterial).opacity = shown.opacity;
      }
    });
  }
  return true;
}

export function disposeEditRuntime(edit: EditRuntime): void {
  edit.group.removeFromParent();
  for (const disposable of edit.disposables) disposable.dispose();
}

export type ClaimRuntime = {
  visual: ClaimTint;
  group: THREE.Group;
  disposables: Array<{ dispose: () => void }>;
};

/** Soft-lock lot tint while a stealable claim is active. Distinct from fail-flash. */
export function createClaimRuntime(visual: ClaimTint, runtime: BuildingRuntime): ClaimRuntime {
  const group = new THREE.Group();
  group.name = `session-kit-claim:${visual.assetRef}`;
  group.position.set(runtime.slot.x, runtime.groundY + 0.04, runtime.slot.z);
  group.rotation.y = runtime.slot.yaw;
  const geometry = new THREE.BoxGeometry(runtime.slot.width * 0.98, 0.16, runtime.slot.depth * 0.98);
  const material = new THREE.MeshBasicMaterial({
    color: CLAIM_COLOR, transparent: true, opacity: CLAIM_OPACITY, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = 0.08;
  group.add(mesh);
  return { visual, group, disposables: [geometry, material] };
}

export function disposeClaimRuntime(claim: ClaimRuntime): void {
  claim.group.removeFromParent();
  for (const disposable of claim.disposables) disposable.dispose();
}
