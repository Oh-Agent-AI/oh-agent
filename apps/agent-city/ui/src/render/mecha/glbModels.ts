/**
 * GLB 机甲资产（规格 docs/design/mecha/2026-10-26/MECHA_3D_CHARACTER_ASSET_PIPELINE_SPEC.md §5）：
 * 解析、按合同校验、实例化。只依赖 three 与 animation.ts 的类型——资产 URL、缓存和 fetch 在 glbRegistry.ts
 * （Vite 专用），这里才能在 node 里被测试直接 import。
 *
 * 任何一步不满足合同都抛 MechaGlbError，调用方（models.ts 的升级逻辑）保留程序模型。宁可退回去，
 * 也不要用一个节点名对不上、片段时长漂移的资产去驱动战斗演出。
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { MechaAction, MechaClipSpec, MechaGlbManifest, MechaRig } from "./animation";

export class MechaGlbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MechaGlbError";
  }
}

export type MechaGlbAsset = {
  manifest: MechaGlbManifest;
  /** 静止姿态的节点树（米制）。实例都是它的克隆，几何与材质共享。 */
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  /** 向后倒地需要的净空（米，静止姿态的最大 z），运行时据此在倒地时抬高。 */
  rearExtent: number;
};

/** 规格 §5.2：驱动节点 → 父节点。静止旋转必须是单位阵（绑定姿态 = 静止姿态）。 */
const NODE_TREE: Record<string, Record<string, string | null>> = {
  Assault: {
    visual: null,
    body: "visual", head: "body",
    upper_arm_l: "body", upper_arm_r: "body", forearm_l: "upper_arm_l", forearm_r: "upper_arm_r",
    thigh_l: "visual", thigh_r: "visual", shin_l: "thigh_l", shin_r: "thigh_r", foot_l: "shin_l", foot_r: "shin_r",
  },
  // 规格 §5.2：Gunner 多一个 railgun（MechaJoint 的 cannon），挂在 body 下，攻击片段沿它做后坐
  Gunner: {
    visual: null,
    body: "visual", head: "body", railgun: "body",
    upper_arm_l: "body", upper_arm_r: "body", forearm_l: "upper_arm_l", forearm_r: "upper_arm_r",
    thigh_l: "visual", thigh_r: "visual", shin_l: "thigh_l", shin_r: "thigh_r", foot_l: "shin_l", foot_r: "shin_r",
  },
};
/** 规格 §5.2 第 5 条：朝向与测试用的标记节点。 */
const MARKERS: Record<string, string[]> = { Assault: ["front", "gauntlet-left", "gauntlet-right", "shield"], Gunner: ["front"] };
const REQUIRED_CLIPS = ["idle", "move", "attack", "hit", "defeat"];
const ACTIONS: MechaAction[] = ["idle", "move", "attack", "repair", "hit", "defeat"];
const CELL_METERS = 16;
/** 片段时长与清单允许的偏差（一帧 @30fps）。 */
const DURATION_TOLERANCE = 1 / 30;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 清单形状校验。形状不对直接抛错，不做任何「宽容」补默认值（缺字段补默认就是静默套用错误动作）。 */
export function parseMechaManifest(json: unknown): MechaGlbManifest {
  const problems: string[] = [];
  if (!isRecord(json)) throw new MechaGlbError("manifest is not an object");
  const str = (k: string) => (typeof json[k] === "string" && json[k] ? (json[k] as string) : (problems.push(`${k} must be a non-empty string`), ""));
  const id = str("id"), role = str("role");
  if (typeof json.version !== "number") problems.push("version must be a number");
  const footprint = json.footprint;
  if (!Array.isArray(footprint) || footprint.length !== 2 || !footprint.every((n) => Number.isInteger(n) && n >= 1)) problems.push("footprint must be [w, d] positive integers");
  if (json.forward !== "-Z") problems.push('forward must be "-Z"');
  if (typeof json.heightMeters !== "number" || !(json.heightMeters > 0)) problems.push("heightMeters must be positive");
  let maxExtent: [number, number] | undefined;
  if (json.maxExtentMeters !== undefined) {
    const e = json.maxExtentMeters;
    const ok = Array.isArray(e) && e.length === 2 && e.every((n) => typeof n === "number" && n > 0);
    // 声明的外伸不能无限大：最多比占地多出一半（再多就该占两格了）
    const fp = Array.isArray(footprint) && footprint.length === 2 ? footprint as number[] : [1, 1];
    if (!ok) problems.push("maxExtentMeters must be [width, depth] in positive meters");
    else if ((e as number[])[0] > fp[0]! * CELL_METERS * 1.5 || (e as number[])[1] > fp[1]! * CELL_METERS * 1.5) problems.push("maxExtentMeters exceeds 1.5 × the footprint");
    else maxExtent = [(e as number[])[0]!, (e as number[])[1]!];
  }
  const clips: Record<string, MechaClipSpec> = {};
  if (!isRecord(json.clips)) problems.push("clips must be an object");
  else {
    for (const [name, raw] of Object.entries(json.clips)) {
      if (!isRecord(raw) || typeof raw.duration !== "number" || !(raw.duration > 0) || typeof raw.loop !== "boolean") {
        problems.push(`clip ${name} needs {duration > 0, loop: boolean}`);
        continue;
      }
      clips[name] = { duration: raw.duration, loop: raw.loop, ...(raw.holdLastFrame === true ? { holdLastFrame: true } : {}) };
    }
    for (const name of REQUIRED_CLIPS) if (!clips[name]) problems.push(`clip ${name} missing`);
  }
  const actionMap: Partial<Record<MechaAction, string>> = {};
  if (json.actionMap !== undefined) {
    if (!isRecord(json.actionMap)) problems.push("actionMap must be an object");
    else {
      for (const [action, target] of Object.entries(json.actionMap)) {
        if (!ACTIONS.includes(action as MechaAction)) problems.push(`actionMap: unknown action ${action}`);
        else if (typeof target !== "string" || !clips[target]) problems.push(`actionMap: ${action} → ${String(target)} is not a clip`);
        else actionMap[action as MechaAction] = target;
      }
    }
  }
  // 动作没有对应片段又没写映射 = 会静默套用错误动作，必须在清单里显式写出来（规格 §4 阶段 D）。
  for (const action of ACTIONS) if (!clips[action] && !actionMap[action]) problems.push(`action ${action} has neither a clip nor an actionMap entry`);
  if (problems.length) throw new MechaGlbError(`invalid manifest: ${problems.join("; ")}`);
  return {
    id, role, version: json.version as number, footprint: footprint as [number, number], forward: "-Z",
    heightMeters: json.heightMeters as number, ...(maxExtent ? { maxExtentMeters: maxExtent } : {}), clips, ...(Object.keys(actionMap).length ? { actionMap } : {}),
    ...(Array.isArray(json.materials) ? { materials: json.materials.filter((m): m is string => typeof m === "string") } : {}),
  };
}

/**
 * 资产合同校验（规格 §5.1–§5.4）。所有问题一次报全，方便一次改完。
 * 要在没有任何动画作用过的静止姿态上调用。
 */
export function validateMechaGlb(scene: THREE.Object3D, clips: THREE.AnimationClip[], manifest: MechaGlbManifest): { rearExtent: number } {
  const problems: string[] = [];
  const tree = NODE_TREE[manifest.role];
  if (!tree) throw new MechaGlbError(`no GLB contract for role ${manifest.role}`);
  scene.updateMatrixWorld(true);

  const seen = new Set<string>();
  scene.traverse((o) => {
    if (!o.name) return;
    if (seen.has(o.name)) problems.push(`duplicate node name ${o.name}`);
    seen.add(o.name);
  });
  const identity = new THREE.Quaternion();
  for (const [name, parent] of Object.entries(tree)) {
    const node = scene.getObjectByName(name);
    if (!node) { problems.push(`missing node ${name}`); continue; }
    // 顶层 visual 的父级是 GLTF 场景根，不是命名节点
    if (parent && node.parent?.name !== parent) problems.push(`${name} is under ${node.parent?.name ?? "nothing"}, expected ${parent}`);
    if (node.quaternion.angleTo(identity) > 1e-5) problems.push(`${name} rest rotation is not identity`);
  }
  for (const name of MARKERS[manifest.role] ?? []) if (!scene.getObjectByName(name)) problems.push(`missing marker node ${name}`);

  // 朝向：front 标记必须在 −Z 侧（规格 §5.1，和 faceMechaTarget 一致）
  const front = scene.getObjectByName("front");
  if (front) {
    const at = new THREE.Vector3(); front.getWorldPosition(at);
    if (at.z > -1) problems.push(`front marker at z=${at.z.toFixed(2)}, the model must face -Z`);
  }

  // 片段：清单里的每个片段都要在 GLB 里、时长对得上
  for (const [name, spec] of Object.entries(manifest.clips)) {
    const clip = clips.find((c) => c.name === name);
    if (!clip) problems.push(`clip ${name} is in the manifest but not in the GLB`);
    else if (Math.abs(clip.duration - spec.duration) > DURATION_TOLERANCE) problems.push(`clip ${name} lasts ${clip.duration.toFixed(3)}s, manifest says ${spec.duration}s`);
  }

  // 尺寸与落点（规格 §5.4）：站在格里、脚在地面、高度和清单一致
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const [fw, fd] = manifest.footprint;
  if (Math.abs(box.min.y) > 0.05) problems.push(`feet are at y=${box.min.y.toFixed(3)} m, expected 0`);
  if (Math.abs(size.y - manifest.heightMeters) > manifest.heightMeters * 0.1) problems.push(`height ${size.y.toFixed(2)} m is more than 10% from the manifest's ${manifest.heightMeters} m`);
  const [maxX, maxZ] = manifest.maxExtentMeters ?? [fw * CELL_METERS - 1, fd * CELL_METERS - 1];
  const where = manifest.maxExtentMeters ? "its declared extent" : `${fw}×${fd} cell(s)`;
  if (size.x > maxX) problems.push(`width ${size.x.toFixed(2)} m does not fit ${where} (${maxX.toFixed(2)} m)`);
  if (size.z > maxZ) problems.push(`depth ${size.z.toFixed(2)} m does not fit ${where} (${maxZ.toFixed(2)} m)`);

  if (problems.length) throw new MechaGlbError(`GLB breaks the contract: ${problems.join("; ")}`);
  return { rearExtent: Math.max(0, box.max.z) };
}

/** 解析 + 校验。data 是 .glb 的字节；path 用于解析 GLB 内引用的相对资源（嵌入式资产不需要）。 */
export async function parseMechaGlb(data: ArrayBuffer, manifest: MechaGlbManifest, path = ""): Promise<MechaGlbAsset> {
  let gltf;
  try {
    gltf = await new GLTFLoader().parseAsync(data, path);
  } catch (error) {
    throw new MechaGlbError(`cannot parse GLB: ${error instanceof Error ? error.message : String(error)}`);
  }
  const scene = gltf.scene;
  const { rearExtent } = validateMechaGlb(scene, gltf.animations, manifest);
  return { manifest, scene, clips: gltf.animations, rearExtent };
}

export type MechaGlbInstance = {
  /** 带 1/metersPerUnit 缩放的包装节点：GLB 是米制，片段里的位移也是米，缩放必须在它们之上。 */
  wrapper: THREE.Group;
  rig: MechaRig;
  /** 停掉 mixer、摘下节点。共享的几何/材质属于缓存，不在这里释放。 */
  dispose: () => void;
};

/** 克隆一份静止姿态并给它独立的 mixer。几何/材质/贴图与缓存共享，所以实例很便宜（两个袭扰者之类共用一份）。 */
export function instantiateMechaGlb(asset: MechaGlbAsset, metersPerUnit: number): MechaGlbInstance {
  const scene = asset.scene.clone(true);
  const visual = scene.getObjectByName("visual");
  if (!visual) throw new MechaGlbError("instance has no visual node");
  const wrapper = new THREE.Group();
  wrapper.name = "mecha-glb";
  wrapper.scale.setScalar(1 / metersPerUnit);
  const lift = new THREE.Group();
  lift.name = "mecha-lift";
  lift.add(scene);
  wrapper.add(lift);
  const mixer = new THREE.AnimationMixer(scene);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of asset.clips) {
    if (!asset.manifest.clips[clip.name]) continue;
    const action = mixer.clipAction(clip);
    // 全部 LoopRepeat、权重 0 常驻；时间折叠和终点夹取在 animation.ts 的 poseGlb 里（见那里的注释）
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    action.setEffectiveWeight(0);
    actions.set(clip.name, action);
  }
  const rig: MechaRig = {
    visual: scene, joints: new Map(), origins: new Map(), role: asset.manifest.role, rearExtent: asset.rearExtent,
    glb: { manifest: asset.manifest, mixer, actions, visual, lift },
  };
  return {
    wrapper, rig,
    dispose: () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
      actions.clear();
      wrapper.removeFromParent();
    },
  };
}

/** 释放缓存里的共享资源（几何、材质、贴图）。只在整个资产缓存作废时调用，不是每个实例的事。 */
export function disposeMechaGlbAsset(asset: MechaGlbAsset): void {
  asset.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(mat)) if (value instanceof THREE.Texture) value.dispose();
      mat.dispose();
    }
  });
}
