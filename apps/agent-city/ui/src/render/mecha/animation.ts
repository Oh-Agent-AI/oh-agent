/** Procedural joint poses. Only the visual rig moves; the board owns placement and health. */
import * as THREE from "three";

export type MechaAction = "idle" | "move" | "attack" | "repair" | "hit" | "defeat";
export type MechaCombatCue = { actor: string; action: MechaAction; target?: string };
export type MechaJoint = "body" | "head" | "arm-left" | "arm-right" | "forearm-left" | "forearm-right" | "leg-left" | "leg-right" | "shin-left" | "shin-right" | "rear-left" | "rear-right" | "cannon" | "drone";
type JointSpec = { parent?: MechaJoint; origin: [number, number, number] };
export type MechaRig = { visual: THREE.Group; joints: Map<MechaJoint, THREE.Group>; origins: Map<MechaJoint, THREE.Vector3>; role: string; rearExtent: number };
const rigs = new WeakMap<THREE.Object3D, MechaRig>();
const durations: Partial<Record<MechaAction, number>> = { attack: 0.95, repair: 1.2, hit: 0.48, defeat: 0.85 };

export function createMechaRig(role: string, metersPerUnit: number): MechaRig {
  const heavy = role === "Assault", quad = role === "Boss" || role === "Raider";
  const boss = role === "Boss";
  const hip = heavy ? 1.9 : 1.55;
  const specs: Record<MechaJoint, JointSpec> = {
    body: { origin: [0, quad ? boss ? 7 : 4 : 9.6, 0] },
    head: { parent: "body", origin: [0, quad ? boss ? 10 : 4.5 : heavy ? 17.3 : 15.7, quad ? boss ? -8.2 : -3.7 : 0] },
    "arm-left": { parent: "body", origin: [heavy ? -4.4 : -3.4, heavy ? 15.5 : 14.5, 0] },
    "arm-right": { parent: "body", origin: [heavy ? 4.4 : 3.4, heavy ? 15.5 : 14.5, 0] },
    "forearm-left": { parent: "arm-left", origin: [heavy ? -5.1 : -3.7, heavy ? 11.4 : 10.8, -0.6] },
    "forearm-right": { parent: "arm-right", origin: [heavy ? 5.1 : 3.7, heavy ? 11.4 : 10.8, -0.6] },
    "leg-left": { origin: [quad ? boss ? -4.2 : -3.2 : -hip, quad ? boss ? 6.9 : 4.4 : 9.3, quad ? boss ? -3.2 : -2.3 : 0] },
    "leg-right": { origin: [quad ? boss ? 4.2 : 3.2 : hip, quad ? boss ? 6.9 : 4.4 : 9.3, quad ? boss ? -3.2 : -2.3 : 0] },
    "shin-left": { parent: "leg-left", origin: [-hip, 5.3, 0] },
    "shin-right": { parent: "leg-right", origin: [hip, 5.3, 0] },
    "rear-left": { origin: [boss ? -4.6 : -3.2, boss ? 6.9 : 4.4, boss ? 4.4 : 2.8] },
    "rear-right": { origin: [boss ? 4.6 : 3.2, boss ? 6.9 : 4.4, boss ? 4.4 : 2.8] },
    cannon: { parent: "body", origin: [2.8, 16, 0.1] },
    drone: { parent: "body", origin: [-5.1, 17.5, 0.3] },
  };
  if (boss) {
    specs["arm-left"].origin = [-6.4, 15.5, -4.2];
    specs["arm-right"].origin = [6.4, 15.2, -3.4];
  }
  const visual = new THREE.Group();
  visual.name = "mecha-visual";
  const joints = new Map<MechaJoint, THREE.Group>();
  const origins = new Map<MechaJoint, THREE.Vector3>();
  for (const [id, spec] of Object.entries(specs) as [MechaJoint, JointSpec][]) {
    const node = new THREE.Group();
    node.name = `joint:${id}`;
    const origin = new THREE.Vector3(...spec.origin).divideScalar(metersPerUnit);
    origins.set(id, origin);
    node.position.copy(origin);
    if (spec.parent) node.position.sub(origins.get(spec.parent)!);
    node.userData.restPosition = node.position.clone();
    (spec.parent ? joints.get(spec.parent)! : visual).add(node);
    joints.set(id, node);
  }
  return { visual, joints, origins, role, rearExtent: 0 };
}

export function registerMechaRig(root: THREE.Group, rig: MechaRig): void {
  root.updateMatrixWorld(true);
  // The model is still unplaced/unscaled here; this is the clearance for a backward fall.
  rig.rearExtent = Math.max(0, new THREE.Box3().setFromObject(root).max.z);
  rigs.set(root, rig);
}

/** Deterministic sampling also supports preview scrubbing and frame-rate independent tests. */
export function poseMechaModel(root: THREE.Object3D, action: MechaAction, seconds: number, reducedMotion = false): void {
  const rig = rigs.get(root);
  if (!rig) return;
  const { visual, joints, role } = rig;
  visual.position.set(0, 0, 0); visual.rotation.set(0, 0, 0);
  for (const node of joints.values()) {
    node.position.copy(node.userData.restPosition as THREE.Vector3);
    node.rotation.set(0, 0, 0);
  }
  const joint = (id: MechaJoint) => joints.get(id)!;
  const quad = role === "Boss" || role === "Raider";
  const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const progress = Math.min(1, t / (durations[action] ?? 1));
  if (action === "defeat") {
    const p = reducedMotion ? 1 : progress * progress * (3 - 2 * progress);
    visual.rotation.x = p * Math.PI / 2;
    visual.position.y = rig.rearExtent * Math.sin(visual.rotation.x);
    return;
  }
  if (reducedMotion) return;
  if (action === "idle" || action === "move") {
    joint("body").position.y += Math.sin(t * 2) * 0.035;
    joint("drone").position.y += Math.sin(t * 3) * 0.16;
  }
  if (action === "move") {
    const step = Math.sin(t * (quad ? 10 : 8));
    joint("leg-left").rotation.x = step * 0.42;
    joint("leg-right").rotation.x = -step * 0.42;
    joint("shin-left").rotation.x = Math.max(0, -step) * 0.5;
    joint("shin-right").rotation.x = Math.max(0, step) * 0.5;
    joint("rear-left").rotation.x = -step * 0.4;
    joint("rear-right").rotation.x = step * 0.4;
    joint("arm-left").rotation.x = -step * 0.23;
    joint("arm-right").rotation.x = step * 0.23;
    joint("body").rotation.x = quad ? 0.06 : -0.05;
    visual.position.y = Math.abs(step) * 0.08;
  } else if (action === "attack" || action === "repair") {
    const arc = Math.sin(progress * Math.PI);
    if (quad) {
      joint("body").rotation.x = -arc * 0.2;
      joint("arm-left").rotation.x = -arc * 1.1;
      joint("arm-right").rotation.x = -arc * 1.1;
      if (role === "Raider") {
        visual.position.y = arc * 0.6;
        joint("leg-left").rotation.x = -arc * 0.65;
        joint("leg-right").rotation.x = -arc * 0.65;
      }
    } else if (role === "Gunner") {
      joint("cannon").position.z += Math.sin(Math.min(1, Math.max(0, progress - 0.25) / 0.75) * Math.PI) * 0.45;
      joint("body").rotation.x = arc * 0.09;
      joint("arm-right").rotation.x = arc * 0.55;
    } else if (role === "Support") {
      if (action === "repair") {
        joint("arm-right").rotation.x = arc * 0.95;
        joint("forearm-right").rotation.x = arc * 0.55;
        joint("drone").position.z -= arc * 1.3;
        joint("drone").position.y += arc * 0.4;
      } else {
        joint("arm-left").rotation.x = arc * 1.2;
        joint("forearm-left").rotation.x = arc * 0.35;
      }
    } else {
      joint("body").rotation.y = -arc * 0.25;
      joint("arm-right").rotation.x = arc * 1.8;
      joint("forearm-right").rotation.x = arc * 0.4;
      joint("arm-left").rotation.x = arc * 0.55;
    }
  } else if (action === "hit") {
    const kick = Math.sin(progress * Math.PI) * (1 - progress);
    joint("body").rotation.x = kick * 0.4;
    visual.rotation.z = Math.sin(progress * Math.PI * 3) * (1 - progress) * 0.17;
    joint("head").rotation.x = kick * 0.3;
  }
}

export class MechaAnimator {
  action: MechaAction = "idle";
  elapsed = 0;
  readonly root: THREE.Object3D;
  constructor(root: THREE.Object3D) { this.root = root; }
  play(action: MechaAction, restart = false): void {
    if (action === this.action && !restart) return;
    this.action = action; this.elapsed = 0;
  }
  seek(progress: number, reducedMotion = false): void {
    this.elapsed = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0)) * (durations[this.action] ?? 1);
    poseMechaModel(this.root, this.action, this.elapsed, reducedMotion);
  }
  update(dt: number, reducedMotion = false, loop = false): void {
    this.elapsed += Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
    const duration = durations[this.action];
    if (duration && this.elapsed > duration && this.action !== "defeat") {
      if (loop) this.elapsed %= duration;
      else this.play("idle");
    }
    poseMechaModel(this.root, this.action, this.elapsed, reducedMotion);
  }
}

/** Presentation queue for an accepted turn. It never writes back to the rules state. */
export class MechaBattleAnimator {
  readonly animator: MechaAnimator;
  private hp: number | null = null;
  private cueId = -1;
  private pending: Array<{ after: number; action: MechaAction }> = [];
  constructor(root: THREE.Object3D) { this.animator = new MechaAnimator(root); }
  sync(hp: number, cueId: number, action?: MechaAction): void {
    const previous = this.hp;
    const changed = this.cueId !== cueId;
    this.hp = hp; this.cueId = cueId;
    if (previous === null) {
      if (hp <= 0) this.animator.play("defeat");
      return;
    }
    if (hp > 0 && previous <= 0) {
      this.pending = []; this.animator.play("idle", true);
      return;
    }
    if (hp <= 0 && previous <= 0) return;
    const damaged = hp < previous;
    if (!changed && !damaged) return;
    this.pending = [];
    let delay = 0;
    if (changed && action && previous > 0) {
      this.animator.play(action, true);
      delay = durations[action] ?? 0;
    } else if (hp > 0) this.animator.play("idle");
    if (damaged) {
      this.pending.push({ after: delay, action: "hit" });
      delay += durations.hit!;
    }
    if (hp <= 0 && previous > 0) this.pending.push({ after: delay, action: "defeat" });
  }
  update(dt: number, moving: boolean, reducedMotion = false): void {
    const step = Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
    for (const cue of this.pending) cue.after -= step;
    while (this.pending[0] && this.pending[0].after <= 0) this.animator.play(this.pending.shift()!.action, true);
    if (this.hp !== null && this.hp > 0 && (this.animator.action === "idle" || this.animator.action === "move")) this.animator.play(moving ? "move" : "idle");
    this.animator.update(step, reducedMotion);
  }
}

/** Models face local -Z. Rotate that forward vector toward the intended target. */
export function faceMechaTarget(root: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  const dx = to.x - from.x, dz = to.z - from.z;
  if (Math.hypot(dx, dz) > 1e-6) root.rotation.y = Math.atan2(-dx, -dz);
}
