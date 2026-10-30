/** Procedural joint poses. Only the visual rig moves; the board owns placement and health. */
import * as THREE from "three";
import type { MechaPerformanceEvent } from "./performance";

export type MechaAction = "idle" | "move" | "attack" | "repair" | "hit" | "defeat";
export type MechaCombatCue = { actor: string; action: MechaAction; target?: string };
export type MechaJoint = "body" | "head" | "arm-left" | "arm-right" | "forearm-left" | "forearm-right" | "leg-left" | "leg-right" | "shin-left" | "shin-right" | "rear-left" | "rear-right" | "cannon" | "drone";
type JointSpec = { parent?: MechaJoint; origin: [number, number, number] };
/** GLB 资产随带的清单（规格 §5.3）：片段时长以它为准，不再写死在代码里。 */
export type MechaClipSpec = { duration: number; loop: boolean; holdLastFrame?: boolean };
export type MechaGlbManifest = {
  id: string;
  version: number;
  role: string;
  footprint: [number, number];
  forward: "-Z";
  heightMeters: number;
  /**
   * 静止姿态允许的最大宽×深（米）。没声明时就是「占格数 × 16 米 − 1」。
   * 声明它 = 明确登记一处设计例外（规格 §5.4.1：Assault 的盾与重拳外伸出本格）；加载器只放行声明过的范围。
   */
  maxExtentMeters?: [number, number];
  clips: Record<string, MechaClipSpec>;
  /** 角色没有的动作映射到哪个片段（例如 repair → attack），不是静默套用。 */
  actionMap?: Partial<Record<MechaAction, string>>;
  materials?: string[];
};
/** GLB 实例的运行时状态：每个实例一个 mixer，所有片段常驻、只按权重切换（见 poseGlb）。 */
export type MechaGlbState = {
  manifest: MechaGlbManifest;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  visual: THREE.Object3D;
  /** mixer 不碰的外层节点（米制）：倒地抬高只能放在这里。mixer 只在轨道值变化时才写回节点，手工改动画驱动的节点会被它遗忘、残留到下一个片段。 */
  lift: THREE.Object3D;
};
export type MechaRig = {
  visual: THREE.Group;
  joints: Map<MechaJoint, THREE.Group>;
  origins: Map<MechaJoint, THREE.Vector3>;
  role: string;
  rearExtent: number;
  /** 有它就走 GLB 片段采样；程序模型没有。 */
  glb?: MechaGlbState;
};
const rigs = new WeakMap<THREE.Object3D, MechaRig>();
const durations: Partial<Record<MechaAction, number>> = { attack: 0.95, repair: 1.2, hit: 0.48, defeat: 0.85 };

/** 换掉某个模型根节点登记的绑定（程序模型 → GLB 的原地升级用）。 */
export function setMechaRig(root: THREE.Object3D, rig: MechaRig): void {
  rigs.set(root, rig);
}

function clipOf(g: MechaGlbState, action: MechaAction): { name: string; spec: MechaClipSpec } {
  const mapped = g.manifest.actionMap?.[action] ?? action;
  const spec = g.manifest.clips[mapped];
  return spec ? { name: mapped, spec } : { name: "idle", spec: g.manifest.clips.idle! };
}

/** 动作在多少秒后结束并回到待机；循环动作（待机/移动）没有终点，返回 undefined。 */
export function mechaActionDuration(root: THREE.Object3D, action: MechaAction): number | undefined {
  const glb = rigs.get(root)?.glb;
  if (!glb) return durations[action];
  const { spec } = clipOf(glb, action);
  return spec.loop ? undefined : spec.duration;
}

/** 整段片段的长度（拖进度条预览用，循环片段也有）；没有登记信息时是 1 秒。 */
export function mechaActionSpan(root: THREE.Object3D, action: MechaAction): number {
  const glb = rigs.get(root)?.glb;
  return glb ? clipOf(glb, action).spec.duration : durations[action] ?? 1;
}

/**
 * GLB 的确定性采样：同一 (动作, 秒) 永远得到同一姿态，和程序模型一样可以拖进度条、可以写测试。
 * 注意三个坑：① LoopOnce 片段播完会被置为 paused，之后 setTime 永远停在 0，所以所有片段都用 LoopRepeat、
 * 由这里自己夹/折时间；② 非循环片段的终点取 duration − 1e-4，否则 LoopRepeat 会折回 0、倒地终态变成站姿；
 * ③ 每个片段都带全部通道，切换片段时不会留下上一个片段的姿态。
 */
function poseGlb(rig: MechaRig, g: MechaGlbState, action: MechaAction, seconds: number, reducedMotion: boolean): void {
  const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  let { name, spec } = clipOf(g, action);
  let time: number;
  if (reducedMotion) {
    if (name === "defeat") time = spec.duration - 1e-4;
    else { name = "idle"; spec = g.manifest.clips.idle!; time = 0; }
  } else {
    time = spec.loop ? t % spec.duration : Math.min(t, spec.duration - 1e-4);
  }
  for (const [id, act] of g.actions) act.setEffectiveWeight(id === name ? 1 : 0);
  g.mixer.setTime(time);
  // 倒地抬高由运行时负责（规格 §5.3：片段不能自带根位移），且只写在 lift 上、不碰 visual。
  g.lift.position.y = name === "defeat" ? rig.rearExtent * Math.sin(g.visual.rotation.x) : 0;
}

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
  if (rig.glb) return poseGlb(rig, rig.glb, action, seconds, reducedMotion);
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
    this.elapsed = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0)) * mechaActionSpan(this.root, this.action);
    poseMechaModel(this.root, this.action, this.elapsed, reducedMotion);
  }
  update(dt: number, reducedMotion = false, loop = false): void {
    this.elapsed += Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
    const duration = mechaActionDuration(this.root, this.action);
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
    // A turn cue is shared by all actors. An unrelated turn must not cancel
    // this actor's queued reaction or interrupt its current animation.
    if (!damaged && (!changed || !action)) return;
    this.pending = [];
    let delay = 0;
    if (changed && action && previous > 0) {
      this.animator.play(action, true);
      delay = mechaActionDuration(this.animator.root, action) ?? 0;
    } else if (hp > 0) this.animator.play("idle");
    if (damaged) {
      this.pending.push({ after: delay, action: "hit" });
      delay += mechaActionDuration(this.animator.root, "hit") ?? durations.hit!;
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

type ActorMap = Record<string, THREE.Group>;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const easeOut = (value: number) => 1 - Math.pow(1 - clamp01(value), 3);
const pulse = (value: number) => Math.sin(clamp01(value) * Math.PI);

/** Sequential, pausable presentation of an accepted round using the shared joint rigs. */
export class MechaPerformancePlayer {
  private readonly actors: ActorMap;
  private readonly events: MechaPerformanceEvent[];
  private readonly cellToWorld: (cell: { x: number; y: number }, actor: string) => THREE.Vector3;
  private readonly onComplete: () => void;
  private readonly positions = new Map<string, THREE.Vector3>();
  private readonly fallen = new Set<string>();
  private readonly tracer: THREE.Line;
  private readonly impact: THREE.Mesh;
  private elapsed = 0;
  private completed = false;

  constructor(
    actors: ActorMap,
    events: MechaPerformanceEvent[],
    cellToWorld: (cell: { x: number; y: number }, actor: string) => THREE.Vector3,
    effectRoot: THREE.Object3D,
    onComplete: () => void,
  ) {
    this.actors = actors;
    this.events = events;
    this.cellToWorld = cellToWorld;
    this.onComplete = onComplete;
    for (const [id, actor] of Object.entries(actors)) this.positions.set(id, actor.position.clone());
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    this.tracer = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: "#9eeaff", transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.tracer.visible = false;
    this.tracer.frustumCulled = false;
    const impactGeometry = new THREE.RingGeometry(0.8, 1.15, 20);
    impactGeometry.rotateX(-Math.PI / 2);
    this.impact = new THREE.Mesh(impactGeometry, new THREE.MeshBasicMaterial({ color: "#fff1ba", transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    this.impact.visible = false;
    effectRoot.add(this.tracer, this.impact);
  }

  update(dt: number): void {
    this.restore();
    this.tracer.visible = false;
    this.impact.visible = false;
    if (this.completed) return;
    const step = Number.isNaN(dt) ? 0 : Math.max(0, dt);
    this.elapsed = Math.min(this.duration(), this.elapsed + step);
    let start = 0;
    for (const event of this.events) {
      const end = start + event.duration;
      if (this.elapsed < end) {
        this.play(event, clamp01((this.elapsed - start) / event.duration));
        return;
      }
      this.settle(event);
      start = end;
    }
    this.completed = true;
    this.onComplete();
  }

  reset(): void {
    this.restore();
    this.tracer.visible = false;
    this.impact.visible = false;
  }

  dispose(): void {
    this.reset();
    this.tracer.removeFromParent();
    this.impact.removeFromParent();
    this.tracer.geometry.dispose();
    (this.tracer.material as THREE.Material).dispose();
    this.impact.geometry.dispose();
    (this.impact.material as THREE.Material).dispose();
  }

  private duration(): number {
    return this.events.reduce((sum, event) => sum + event.duration, 0);
  }

  private restore(): void {
    for (const [id, actor] of Object.entries(this.actors)) {
      actor.position.copy(this.positions.get(id)!);
      actor.rotation.x = 0;
      actor.rotation.z = 0;
      poseMechaModel(actor, this.fallen.has(id) ? "defeat" : "idle", this.fallen.has(id) ? 1 : this.elapsed);
    }
  }

  private settle(event: MechaPerformanceEvent): void {
    if (event.kind === "move" || event.kind === "knockback") {
      const at = this.cellToWorld(event.path[event.path.length - 1], event.actor);
      this.positions.set(event.actor, at);
      this.actors[event.actor]?.position.copy(at);
    } else if (event.kind === "death") {
      this.fallen.add(event.actor);
      const at = this.cellToWorld(event.at, event.actor);
      this.positions.set(event.actor, at);
      this.actors[event.actor]?.position.copy(at);
      poseMechaModel(this.actors[event.actor], "defeat", 1);
    }
  }

  private play(event: MechaPerformanceEvent, progress: number): void {
    const actor = this.actors[event.actor];
    if (!actor) return;
    if (event.kind === "death") {
      poseMechaModel(actor, "defeat", progress * event.duration);
      return;
    }
    if (event.kind === "move" || event.kind === "knockback") {
      const scaled = progress * (event.path.length - 1);
      const index = Math.min(event.path.length - 2, Math.floor(scaled));
      const local = scaled - index;
      const from = this.cellToWorld(event.path[index], event.actor);
      const to = this.cellToWorld(event.path[index + 1], event.actor);
      actor.position.lerpVectors(from, to, event.kind === "knockback" ? easeOut(progress) : local);
      faceMechaTarget(actor, from, to);
      if (event.kind === "move") poseMechaModel(actor, "move", this.elapsed);
      else {
        actor.rotation.x = -pulse(progress) * 0.18;
        actor.position.y += pulse(progress) * 0.6;
      }
      return;
    }
    if (event.kind !== "attack") return;
    const from = this.cellToWorld(event.from, event.actor);
    const target = this.cellToWorld(event.target, event.targetIds[0] ?? event.actor);
    const direction = target.clone().sub(from);
    direction.y = 0;
    faceMechaTarget(actor, from, target);
    const action = event.attack === "repair" ? "repair" : "attack";
    poseMechaModel(actor, action, progress * (action === "repair" ? 1.2 : 0.95));
    const hit = pulse((progress - 0.36) / 0.42);
    if (event.attack === "shoot" || event.attack === "pierce") {
      if (progress > 0.3 && progress < 0.7) this.beam(from, target, event.attack === "pierce" ? "#fff0a6" : "#8eeaff", event.attack === "pierce" ? 0.75 : 0.48);
    } else if (event.attack === "repair") {
      if (progress > 0.18 && progress < 0.88) this.beam(from, target, "#68ffc5", 0.55);
    } else {
      const reach = event.actor === "boss" ? 3.4 : event.attack === "charge" ? 2.5 : 1.25;
      if (direction.lengthSq() > 0) actor.position.add(direction.normalize().multiplyScalar(pulse(progress) * reach));
      if (progress > 0.4 && progress < 0.72) this.flash(target, event.attack === "sweep" ? "#ff8a72" : "#ffe0a0", 1 + hit * 2);
    }
    for (const id of event.targetIds) {
      const targetActor = this.actors[id];
      if (!targetActor || this.fallen.has(id)) continue;
      poseMechaModel(targetActor, "hit", hit * 0.48);
      targetActor.position.add(direction.clone().normalize().multiplyScalar(hit * 0.35));
    }
  }

  private beam(from: THREE.Vector3, to: THREE.Vector3, color: string, opacity: number): void {
    from = from.clone();
    to = to.clone();
    from.y += 16;
    to.y += 10;
    const attribute = this.tracer.geometry.getAttribute("position") as THREE.BufferAttribute;
    attribute.setXYZ(0, from.x, from.y, from.z);
    attribute.setXYZ(1, to.x, to.y, to.z);
    attribute.needsUpdate = true;
    const material = this.tracer.material as THREE.LineBasicMaterial;
    material.color.set(color);
    material.opacity = opacity;
    this.tracer.visible = true;
    this.flash(to, color, 1.3);
  }

  private flash(at: THREE.Vector3, color: string, scale: number): void {
    this.impact.position.copy(at);
    this.impact.position.y += 0.8;
    this.impact.scale.setScalar(scale);
    (this.impact.material as THREE.MeshBasicMaterial).color.set(color);
    this.impact.visible = true;
  }
}
