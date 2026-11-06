/**
 * BuildingModel 契约与 Part 字母表（CITY_BUILDING_MODEL_SPEC v2 §3/§4）。纯类型 + 常量，无 three 依赖，守卫可直接 import。
 * 一个 model = 身份 + geometry()（seed → Part[] 纯数据）+ 生命周期声明 + 拾取信息；
 * 造型由 render/buildingCompiler.ts 编译成 THREE.Group。
 */
import type { PhysicalDeclaration } from "./physical";

export type BuildingSemantics = "data" | "scale" | "decor"; // = CatalogKind

export const PART_ROLES = ["wall", "trim", "roof", "glass", "structure", "water", "lit", "beam"] as const;
export type PartRole = (typeof PART_ROLES)[number];

/** 发光取灯光预算类别（cityLightBudget.ts），不接受自由倍率。 */
export const LIGHT_KINDS = ["landmark", "neon", "street-head", "beacon"] as const;
export type LightKind = (typeof LIGHT_KINDS)[number];

export type Vec3 = [number, number, number];

export interface BuildingModel {
  /** ① 身份：与 CITY_CATALOG 的 id 一一对应。 */
  id: string;
  group: "地标" | "公共建筑" | "海滨与港口";
  semantics: Exclude<BuildingSemantics, "data">;
  title: string; // i18n 扫描源
  body: string; // i18n 扫描源
  /** ② 选址引用（不是选址实现），仅供守卫交叉校验。 */
  sitingKey?: string;
  /** ③ 造型：纯函数，禁 Math.random/Date，随机走 hashSeed。 */
  geometry: (input: GeometryInput) => BuildingPlan;
  /** ④ 生命周期（编译器解释）。 */
  lifecycle: {
    grow?: { mode: "civic-pace" };
    night?: { windows: "none" | "canvas"; litParts?: string[] };
    spin?: Array<{ parts: string[]; axis: "x" | "y" | "z"; speed: number }>;
    blink?: { parts: string[]; periodMs: number };
  };
  /** ⑤ 拾取：decorId 沿用现命名，describe 直出 DecorInfo 正文。 */
  picking: { decorId: string; category: string; describe: string };
  /**
   * ⑥ 物理声明（CITY_MODEL_PHYSICAL_INVARIANTS_SPEC §3，批 A+）：占地/基础/入口/运动包络的模型自身事实，
   * 由 declarePhysical 工厂构造（自洽验证 + 深只读）。场景关系（不落水、不压路、入口可达）仍由守卫验证；
   * 未声明的模型登记在 registry 的 PHYSICAL_PENDING（禁止静默）。
   */
  physical?: PhysicalDeclaration;
}

export type GeometryInput = {
  seed: number; // hashSeed(落地实例 id)
  radius?: number; // 规划下发的用地半径
  district?: { wall: string; roof: string; accent: string };
  /** 形态参数（塔高上限 cap、霓虹开关 neon 等；数值化便于序列化）。 */
  sizing?: Record<string, number>;
  siting?: { shore?: [number, number] };
};

export type BuildingPlan = Part[];

/**
 * 烘焙旋转（几何自身的 rotateX/Y/Z，在 anchor 平移之前依次施加）。
 * 与 `rot`（网格旋转）不同：烘焙进顶点缓冲，世界矩阵不变。宝塔四棱锥檐 rotateY(π/4)、霓虹环 rotateX(π/2) 靠它表达。
 */
export type BakedRotation = { x?: number; y?: number; z?: number };

type PartCommon = {
  id?: string; // lifecycle 引用名；同 plan 内唯一
  at: Vec3;
  anchor?: "base" | "center"; // base = y 为底面：几何沿 +y 平移半高（仅 box/cylinder/cone；这三种缺省 base，其余缺省 center）
  rot?: Vec3; // 网格欧拉角（xyz 序）
  bake?: BakedRotation;
  /** 烘焙平移，施加在 bake 旋转「之前」（旧造型 `.translate(...).rotateZ(...)` 的顺序，如灯塔光束锥）。 */
  preShift?: Vec3;
  /** 挂到哪个 group 件之下（at/rot 相对该 group）；group 必须先于子件出现。 */
  parent?: string;
  /** 烘焙平移（几何自身 translate，在 anchor 平移之后）；旧造型把几何整体 translate(0,-h/2,0) 之类的写法靠它逐位保留。 */
  shift?: Vec3;
  role: PartRole;
  color?: string; // hex 或令牌 "district:wall" / "district:roof" / "district:accent"
  side?: "front" | "double";
  /** 发光取灯光预算类别；仅 role:"lit" 生效、且 lit 件必须声明。 */
  light?: LightKind;
  /**
   * 迁移期逃生口：自身颜色 × emissive 的自发光倍率（旧 `material(color, emissive)` 的第二个参数）。
   * 只为让既有造型逐位等价而保留；守卫限定只允许出现在 role:"lit" 件上，批 5 会换成预算类别。
   */
  emissive?: number;
};

/** 容器件：一个空 Group（摩天轮转盘、灯塔光束），子件用 `parent` 引用它的 id；lifecycle.spin 转的就是它。 */
export type GroupPart = { kind: "group"; id: string; at: Vec3; rot?: Vec3; parent?: string };

export type Part =
  | GroupPart
  | (PartCommon & { kind: "box"; size: Vec3 })
  /** size = [底面直径, 高, 底面直径]；radiusTop 是顶面绝对半径（缺省 = 底面半径）。 */
  | (PartCommon & { kind: "cylinder"; size: Vec3; radiusTop?: number; open?: boolean; /** 角度范围 [thetaStart, thetaLength]，缺省整圈（半圆拱券内壁用）。 */ arc?: [number, number]; segments?: number })
  | (PartCommon & { kind: "cone"; size: Vec3; segments?: number; open?: boolean })
  /** size = 三轴半径（非均匀时在球几何上烘焙缩放）；segments = [经向, 纬向]。 */
  | (PartCommon & { kind: "sphere"; size: Vec3; /** 烘焙非均匀缩放：先建半径 size[0] 的球再 scale(stretch)，逐位复刻旧 `new SphereGeometry(r).scale(a,b,c)`；缺省时由 size 三轴半径推出。 */ stretch?: Vec3; segments?: [number, number]; phi?: [number, number]; theta?: [number, number] })
  /** segments = [管截面, 环向]；arc 缺省整圈。 */
  | (PartCommon & { kind: "torus"; radius: number; tube: number; arc?: number; segments?: [number, number] })
  | (PartCommon & { kind: "tube"; radius: number; points: Vec3[]; segments?: number; radialSegments?: number })
  | (PartCommon & { kind: "instanced"; base: "box" | "cylinder"; pieces: Array<{ at: Vec3; size: Vec3; rot?: Vec3; color?: string }> })
  | (PartCommon & { kind: "panel"; size: Vec3; texture: "windows:canvas" })
  | (PartCommon & { kind: "bulbs"; batch: "heads" | "neon"; pieces: Vec3[]; tint?: "budget-desaturated" });

export type PartKind = Part["kind"];
