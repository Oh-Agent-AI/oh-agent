import * as THREE from "three";
import type { MaterialFactory } from "./landmarkMaterials";
import type { BuildingModel, BuildingPlan, GeometryInput, GroupPart, Part } from "../models/model";

/**
 * 单体编译器（CITY_BUILDING_MODEL_SPEC v2 §5）：一份 Part[] 计划 → 挂进宿主 Group 的网格。
 * 职责：材质按 (color, emissive, side) 缓存（缓存活在传入的 MaterialFactory 里，与未迁移的手写造型共用同一张表）、
 * 几何登记 dispose、返回 id → 对象表供 lifecycle 引用。网格不命名：场景基线（verify-city-scene-baseline）按网格名分组，旧造型的网格都是匿名的，命名会改变它；拾取靠宿主 Group 名（city-landmark-<kind>）。
 * 不做批量归并。panel / bulbs 两类件需要引擎侧夜灯与贴图通道，本批未接，遇到会明确抛错而不是静默漏画。
 *
 * 位姿约定与旧手写造型逐位一致（场景图哈希的前提）：base 锚点 = 几何沿 +y 平移半高、网格放在 `at`；
 * center 锚点 = 不平移；`bake` 在平移之前对几何依次 rotateX/Y/Z；`rot` 直接写网格 rotation（xyz 序）。
 */
export interface CompileTarget {
  group: THREE.Object3D;
  /** lifecycle.spin 的登记处（= host.landmarkSpinners）；缺省则忽略 spin。 */
  spinners?: Array<{ object: THREE.Object3D; axis: "x" | "y" | "z"; speed: number }>;
  spin?: BuildingModel["lifecycle"]["spin"];
  material: MaterialFactory;
  disposables: Array<{ dispose: () => void }>;
  /**
   * 编译回调（CITY_MODEL_PHYSICAL_INVARIANTS_SPEC §4.5）：每件落位并挂进场景树后回调一次，
   * 给检查方 part ↔ 编译产物的唯一对应通道。检查器消费编译产物（世界矩阵/包围盒），
   * 不自写变换累积；缺省 undefined，零行为影响。
   */
  onPart?: (part: Part, object: THREE.Object3D) => void;
}

/** 缺省锚点：实心棱柱/圆柱/圆锥以底面为 y，其余件以中心为 y。 */
function anchorOf(part: Exclude<Part, GroupPart>): "base" | "center" {
  return part.anchor ?? (part.kind === "box" || part.kind === "cylinder" || part.kind === "cone" ? "base" : "center");
}

function resolveColor(color: string | undefined, input: GeometryInput | undefined): string {
  if (!color) return "#ffffff";
  if (!color.includes(":")) return color;
  const [scope, key] = color.split(":");
  if (scope === "district" && input?.district && key in input.district) return input.district[key as keyof typeof input.district];
  throw new Error(`buildingCompiler: unresolved colour token ${color}`);
}

function baseGeometry(part: Exclude<Part, GroupPart>): THREE.BufferGeometry {
  switch (part.kind) {
    case "box": return new THREE.BoxGeometry(...part.size);
    case "cylinder": {
      const r = part.size[0] / 2;
      return new THREE.CylinderGeometry(part.radiusTop ?? r, r, part.size[1], part.segments ?? 8, 1, part.open ?? false, ...(part.arc ?? []));
    }
    case "cone": return new THREE.ConeGeometry(part.size[0] / 2, part.size[1], part.segments ?? 8, 1, part.open ?? false);
    case "sphere": {
      const [rx, ry, rz] = part.size;
      const [w, h] = part.segments ?? [16, 12];
      const phi = part.phi ?? [0, Math.PI * 2];
      const theta = part.theta ?? [0, Math.PI];
      const g = new THREE.SphereGeometry(rx, w, h, phi[0], phi[1], theta[0], theta[1]);
      if (part.stretch) return g.scale(...part.stretch);
      return ry === rx && rz === rx ? g : g.scale(1, ry / rx, rz / rx);
    }
    case "torus": {
      const [radial, tubular] = part.segments ?? [8, 24];
      return new THREE.TorusGeometry(part.radius, part.tube, radial, tubular, part.arc ?? Math.PI * 2);
    }
    case "tube": {
      const curve = new THREE.CatmullRomCurve3(part.points.map((p) => new THREE.Vector3(...p)));
      return new THREE.TubeGeometry(curve, part.segments ?? 24, part.radius, part.radialSegments ?? 6, false);
    }
    default: throw new Error(`buildingCompiler: part kind ${part.kind} is not supported yet`);
  }
}

/**
 * 件几何的唯一实现（§4.5 变换唯一实现）：preShift → bake → anchor(base 抬升) → shift，全部烘进顶点。
 * 检查器（verify-city-physical 等）与本编译器共用这一个函数；在守卫里重写等价累积 = 门禁失败。
 */
export function placedGeometry(part: Exclude<Part, GroupPart>): THREE.BufferGeometry {
  const g = baseGeometry(part);
  if (part.preShift) g.translate(...part.preShift);
  if (part.bake) {
    if (part.bake.x) g.rotateX(part.bake.x);
    if (part.bake.y) g.rotateY(part.bake.y);
    if (part.bake.z) g.rotateZ(part.bake.z);
  }
  if (anchorOf(part) === "base") {
    if (part.kind !== "box" && part.kind !== "cylinder" && part.kind !== "cone") throw new Error(`buildingCompiler: anchor "base" is only defined for box/cylinder/cone (got ${part.kind})`);
    g.translate(0, part.size[1] / 2, 0);
  }
  if (part.shift) g.translate(...part.shift);
  return g;
}

/** 件位姿的唯一实现（§4.5）：网格/组件写 at（+ 可选 rot）；instanced 件只写 at（件内 pieces 自带位姿）。 */
export function applyPartPlacement(object: THREE.Object3D, part: Part): void {
  object.position.set(...part.at);
  if (part.rot && part.kind !== "instanced") object.rotation.set(...part.rot);
}

/** role:"beam" 的共享材质：加色半透明（旧灯塔光束材质逐位照搬）；一次编译内同色共用一份，登记 dispose。 */
function beamMaterial(color: string, target: CompileTarget, cache: Map<string, THREE.MeshBasicMaterial>): THREE.MeshBasicMaterial {
  const hit = cache.get(color);
  if (hit) return hit;
  const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.6), transparent: true, opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  target.disposables.push(m);
  cache.set(color, m);
  return m;
}

export function compileBuilding(plan: BuildingPlan, target: CompileTarget, input?: GeometryInput): Map<string, THREE.Object3D> {
  const byId = new Map<string, THREE.Object3D>();
  const beams = new Map<string, THREE.MeshBasicMaterial>();
  const parentOf = (part: Part): THREE.Object3D => {
    if (!part.parent) return target.group;
    const p = byId.get(part.parent);
    if (!p) throw new Error(`buildingCompiler: parent group ${part.parent} must precede its children`);
    return p;
  };
  for (const part of plan) {
    if (part.kind === "group") {
      const g = new THREE.Group();
      applyPartPlacement(g, part);
      parentOf(part).add(g);
      byId.set(part.id, g);
      target.onPart?.(part, g);
      continue;
    }
    if (part.kind === "instanced") {
      const unit = part.base === "box" ? new THREE.BoxGeometry(1, 1, 1) : new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
      const mesh = new THREE.InstancedMesh(unit, target.material(resolveColor(part.color, input), part.emissive ?? 0, { side: part.side }), part.pieces.length);
      const m = new THREE.Matrix4(); const q = new THREE.Quaternion(); const e = new THREE.Euler();
      part.pieces.forEach((piece, i) => {
        q.setFromEuler(e.set(...(piece.rot ?? [0, 0, 0])));
        m.compose(new THREE.Vector3(...piece.at), q, new THREE.Vector3(...piece.size));
        mesh.setMatrixAt(i, m);
        if (piece.color) mesh.setColorAt(i, new THREE.Color(resolveColor(piece.color, input)));
      });
      applyPartPlacement(mesh, part);
      parentOf(part).add(mesh);
      target.disposables.push(unit);
      if (part.id) byId.set(part.id, mesh);
      target.onPart?.(part, mesh);
      continue;
    }
    const geometry = placedGeometry(part);
    const color = resolveColor(part.color, input);
    const mesh = new THREE.Mesh(geometry, part.role === "beam" ? beamMaterial(color, target, beams) : target.material(color, part.emissive ?? 0, { side: part.side }));
    applyPartPlacement(mesh, part);
    mesh.castShadow = part.role !== "beam";
    mesh.receiveShadow = part.role !== "beam";
    parentOf(part).add(mesh);
    target.disposables.push(geometry);
    if (part.id) byId.set(part.id, mesh);
    target.onPart?.(part, mesh);
  }
  // lifecycle.spin：只登记本次 plan 里真有的件（灯塔光束只在霓虹开时出现）。
  for (const s of target.spin ?? []) for (const id of s.parts) { const object = byId.get(id); if (object) target.spinners?.push({ object, axis: s.axis, speed: s.speed }); }
  return byId;
}

/** 把一个 model 包成旧的 LandmarkCtx 造型函数（registry 用它让 buildLandmarks 的 kind 分发不变）。 */
export function compiledBuilder(model: BuildingModel, seedOf: (id: string) => number) {
  return (ctx: { group: THREE.Group; material: MaterialFactory; cap: number; neon: boolean; landmark: { id: string; radius: number }; host: { disposables: Array<{ dispose: () => void }>; landmarkSpinners: NonNullable<CompileTarget["spinners"]> } }): void => {
    const shore = (ctx.landmark as { shore?: { x: number; z: number } }).shore;
    const input: GeometryInput = { seed: seedOf(ctx.landmark.id), radius: ctx.landmark.radius, sizing: { cap: ctx.cap, neon: ctx.neon ? 1 : 0, baseY: ctx.group.position.y }, ...(shore ? { siting: { shore: [shore.x, shore.z] as [number, number] } } : {}) };
    compileBuilding(model.geometry(input), { group: ctx.group, material: ctx.material, disposables: ctx.host.disposables, spinners: ctx.host.landmarkSpinners, spin: model.lifecycle.spin }, input);
  };
}
