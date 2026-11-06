import type * as THREE from "three";
import type { CityBuilding } from "../../cityModel";
import type { CrownPiece } from "../cityHotelCrown";
import type { RooftopSignPlan } from "../citySkylineProps";
import type { DistrictLayout, Parcel, TerrainField, Vec2 } from "../cityLayout";

export type QualityLevel = 0 | 1 | 2;

export type BuildingRuntime = {
  building: CityBuilding;
  slot: Parcel;
  /** 渲染立面（地块分区驱动，覆盖模型层 hash）。 */
  facade: number;
  /** 地基海拔：楼底、吊车、选中环的基准 y。 */
  groundY: number;
  paletteWall: THREE.Color;
  display: number;
  target: number;
  /** 上一份渲染对象里已有高度（分页/刷新回访的楼）：重建不重演生长；
   *  false = 本轮新到的楼，display 从 0 长入（懒加载的「逐步更新到完整城市」）。 */
  settled: boolean;
  district: DistrictLayout;
  shaftPrimary: number;
  shaftUpper: number;
  podium: number;
  roof: number;
  scaffold: number;
  antenna: number;
  beacon: number;
  craneMast: number;
  craneArm: number;
  cranePhase: number;
  /** 吊车立柱的世界坐标：applyConstruction 按地块 yaw 与楼宽算出，逐帧的吊臂旋转复用同一份。 */
  craneX: number;
  craneZ: number;
  blinkPhase: number;
  /** 装饰艺术附件实例起点（-1 = 不是海滨装饰楼）：corner 用 decoCornerMesh[i]，trim 用 decoTrimMesh[2i, 2i+1]。 */
  deco: number;
  /** 屋顶轮廓：0 平顶 / 1 坡顶 / 2 尖顶 / 3 退台冠 / 4 屋顶花园。只由 (分区, 楼型, seed) 决定，确定性。 */
  roofKind: number;
  /** 全城 token 最多的会话：专属冠顶 + 灯环 + 光束。 */
  hero: boolean;
  /** L-6 圆筒玻璃塔实例下标（-1 = 普通方楼）。 */
  cylinder: number;
  /** 海滨酒店冠（L-1）：crownBase = 鳍片实例起点（-1 = 无冠）；方案建模期算一次存住，逐帧只写矩阵。 */
  crownBase: number;
  crown: { fins: CrownPiece[]; stripY: number } | null;
  /** 屋顶立牌（L-2）：四批次（柱×2/板×1/框×4/条×n）共用的牌位起点（-1 = 无牌）。 */
  signBase: number;
  signPlan: RooftopSignPlan | null;
};

/** terrain 非空 → 车贴地行驶；桥面路径 terrain 为空、y 固定。 */
export type CarPath = { points: Vec2[]; cumulative: number[]; total: number; y: number; terrain: TerrainField | null };
export type Car = { path: CarPath; distance: number; speed: number };

/** 夜间照明：路灯灯头（自发光）、地面光斑（加色）、高架灯带。亮度由 setNightGlow 统一驱动。
 *  plan 是全部灯位的纯函数描述（与实例矩阵同源同序）——开车模式解析街灯（N5）从这里取灯，
 *  不再各算一套。 */
export type NightLights = { heads: THREE.MeshBasicMaterial; pools: THREE.MeshBasicMaterial; strips: THREE.MeshBasicMaterial; neon: THREE.MeshBasicMaterial; plan: import("../render/nightLighting").StreetLampPlan[] };
