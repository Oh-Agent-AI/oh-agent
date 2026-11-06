import type { BuildingModel } from "./model";
import { tvTowerModel } from "./landmarks/tvTower";
import { archModel } from "./landmarks/arch";
import { sailOperaModel } from "./landmarks/sailOpera";
import { lighthouseModel } from "./landmarks/lighthouse";
import { ferrisWheelModel } from "./landmarks/ferrisWheel";
import { pagodaModel } from "./landmarks/pagoda";
import { SITE_CLASSES } from "./siteClasses";

/** 已声明化（BuildingModel）的建筑；其余 kind 仍走 render/landmarkBuilders.ts 里手写的 drawX（批 1 逐个迁）。守卫 verify-city-models 按这张表驱动。 */
export const BUILDING_MODELS: BuildingModel[] = [tvTowerModel, pagodaModel, archModel, sailOperaModel, lighthouseModel, ferrisWheelModel];

/**
 * 豁免白名单（CITY_BUILDING_MODEL_SPEC §9「禁止静默」）：render/landmarkBuilders.ts 的 LANDMARK_BUILDERS 里仍走手写 drawX 的 kind，必须在这里登记一行理由。
 * verify-city-models 断言「每个 kind 要么在 BUILDING_MODELS、要么在这里，不同时」且条数 ≤ 6——不能悄悄变长；转成 model 就从这里删掉。
 */
export const UNPARADIGMED: Record<string, string> = {
  "twin-towers": "运行时 renderCanvas 窗贴图 + 日/夜两张贴图经 host.landmarkWindows 切换（需 panel 件与夜窗通道，批 3 一并做）",
  "twist-tower": "运行时 renderCanvas 窗贴图 + 日/夜两张贴图经 host.landmarkWindows 切换（同 twin-towers）",
  "villa-complex": "自包含模块 cityLandmarkVilla（件数组自带，另行收编）",
  "islet-mansion": "自包含模块 cityIsletMansion（布局期装饰，规划层不知道它；件数组自带，另行收编）",
  "islet-grounds": "豪宅岛场地（环路/支路/棕榈，实例化网格），布局与 cityIsletEstate 同源；另行收编",
  "suspension-bridge": "路径依赖：随过河桥与路网高度定形（SPEC §7 定为不迁），灯串直接加进 host.group",
};

/**
 * 物理声明待声明清单（CITY_MODEL_PHYSICAL_INVARIANTS_SPEC §4.6「禁止静默」，批 A 起）：
 * BUILDING_MODELS 里尚未携带 physical 的模型必须在这里登记一行理由。
 * verify-city-physical 断言「每个模型要么已声明、要么在这里，不同时」且条数只减不增（批 A = 3）；
 * 补声明就从这里删掉。批 B 起 station/stadium 模型声明化时同样入册。
 */
export const PHYSICAL_PENDING: Record<string, string> = {
  "tv-tower": "批 A 只选三型（arch/sail-opera/ferris-wheel 覆盖并集空洞/入口/运动包络三类契约），塔型批 B 补",
  "pagoda": "同上，批 B 补（多檐悬挑的高度段包络是其特有考点）",
  "lighthouse": "岸型：陆侧基础与水侧防波堤分开声明（spec §3.1 贴岸模型），留批 D",
};

/**
 * 建筑模型注册表（纯数据层 L3，不依赖 three/render）：kind → 中文名与声明化模型清单。
 * 造型函数表 LANDMARK_BUILDERS（kind → 把模型/手写 drawX 编译成 three 对象）在 render/landmarkBuilders.ts——
 * 它要值导入 three 与 buildingCompiler，放在 models/ 就反向依赖了上层（CITY_ARCHITECTURE §1 / verify-city-import-boundary 规则 3）。
 * 新增地标 = 加一个 model 文件 + 这里进 BUILDING_MODELS + render/landmarkBuilders.ts 加一行。
 */

/** 地标/配套的中文名（点击说明与建筑说明共用；有造型文件的 kind 与「由其它模块建造」的 kind 在同一张表里）。 */
export const LANDMARK_LABELS: Record<string, string> = {
  "sail-opera": "帆形歌剧院", arch: "凯旋拱门", lighthouse: "灯塔",
  "ferris-wheel": "摩天轮", "suspension-bridge": "悬索桥", "truss-bridge": "桁架桥", "twin-towers": "双子塔", "twist-tower": "扭转塔",
  "twisting-deco-tower": "扭转装饰艺术塔",
  airport: "机场岛", // cityAirport.ts 建造
  "villa-complex": "地中海庄园", // cityLandmarkVilla.ts 建造
  "islet-mansion": "豪宅岛庄园", // cityIsletMansion.ts 建造
  "islet-grounds": "豪宅岛场地", // render/landmarks/isletGrounds.ts 建造
  ...Object.fromEntries(BUILDING_MODELS.map((m) => [m.id, m.title])), // 已声明化的建筑：名称由 model.title 派生
};
export const CIVIC_LABELS: Record<string, string> = Object.fromEntries(SITE_CLASSES
  .filter(item => item.family === "civic").map(item => [item.id.slice("civic:".length), item.title]));
