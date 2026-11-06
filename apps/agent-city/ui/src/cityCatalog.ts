/**
 * City 建筑模型总登记表（单一来源）：City 里每一类建模建筑都在这里登记——缩略图、是否代表数据、用途说明、
 * 由哪个模块/函数构建。用户：「把所有建模建筑都集中在一起管理」。
 *
 * - 「建筑说明」面板（CityExperience）逐条渲染本表；「查看实时模型」用 id 调 CityEngine.catalogTarget/focusCatalog。
 * - 新增一类建筑时：在 `source` 指向的模块里建模 → 在这里登记一条 → CityEngine.catalogTarget 加取景点 →
 *   截缩略图进 assets/catalog/ 并登记 LICENSES.md → i18n.tsx 补英文（verify-city-i18n-catalog 扫描本文件）。
 *   守卫 scripts/verify-city-catalog.mjs 检查：每条都有缩略图、id 唯一、catalogTarget 有对应分支。
 * - 缩略图是 City 自身程序化模型的渲染截图，不是外部模型（CITY_LANDMARK_BACKLOG §1：地标一律程序化原创几何）。
 */
import sessionTower from "./assets/catalog/session-tower.jpg";
import sessionSlab from "./assets/catalog/session-slab.jpg";
import sessionDeco from "./assets/catalog/session-deco.jpg";
import sessionHotel from "./assets/catalog/session-hotel.jpg";
import heroTower from "./assets/catalog/hero-tower.jpg";
import districtLandmark from "./assets/catalog/district-landmark.jpg";
import twinTowers from "./assets/catalog/twin-towers.jpg";
import twistTower from "./assets/catalog/twist-tower.jpg";
import tvTower from "./assets/catalog/tv-tower.jpg";
import villa from "./assets/catalog/villa.jpg";
import ferrisWheel from "./assets/catalog/ferris-wheel.jpg";
import sailOpera from "./assets/catalog/sail-opera.jpg";
import arch from "./assets/catalog/arch.jpg";
import lighthouse from "./assets/catalog/lighthouse.jpg";
import pagoda from "./assets/catalog/pagoda.jpg";
import suspensionBridge from "./assets/catalog/suspension-bridge.jpg";
import trussBridge from "./assets/catalog/truss-bridge.jpg";
import expressway from "./assets/catalog/expressway.jpg";
import civicHall from "./assets/catalog/civic-hall.jpg";
import station from "./assets/catalog/station.jpg";
import stadium from "./assets/catalog/stadium.jpg";
import observationTower from "./assets/catalog/observation-tower.jpg";
import park from "./assets/catalog/park.jpg";
import hospital from "./assets/catalog/hospital.jpg";
import school from "./assets/catalog/school.jpg";
import mall from "./assets/catalog/mall.jpg";
import garden from "./assets/catalog/garden.jpg";
import harbor from "./assets/catalog/harbor.jpg";
import airport from "./assets/catalog/airport.jpg";
import signs from "./assets/catalog/signs.jpg";
import beach from "./assets/catalog/beach.jpg";

export type CatalogKind = "data" | "scale" | "decor";
export type CatalogGroup = "会话楼" | "地标" | "桥与道路" | "公共建筑" | "海滨与港口";
export type CatalogEntry = { id: string; group: CatalogGroup; image: string; title: string; kind: CatalogKind; body: string; source: string };

/** kind：data = 代表会话数据；scale = 随会话规模出现；decor = 纯装饰，不代表数据。source：构建它的模块与函数。 */
export const CITY_CATALOG: CatalogEntry[] = [
  { id: "session-tower", group: "会话楼", image: sessionTower, title: "会话塔楼", kind: "data", source: "cityParts.buildRuntimes / formOf", body: "一栋会话楼代表一次会话，楼高表示 token 规模。区内地价最高（靠近城区中心、主干道、水岸）的地块长成玻璃幕墙塔楼。颜色标识所属执行环境城区。" },
  { id: "session-slab", group: "会话楼", image: sessionSlab, title: "会话板楼 / 街坊楼", kind: "data", source: "cityParts.buildRuntimes / formOf", body: "同样代表一次会话；区内地价较低的地块长成宽而浅的板楼或街坊楼。形态只随地价变化，楼高仍由 token 决定。" },
  { id: "session-deco", group: "会话楼", image: sessionDeco, title: "海滨装饰艺术楼", kind: "data", source: "cityParts.facadeFor (facade 3)", body: "临海区较矮的会话楼换成迈阿密装饰艺术风格：粉彩墙面、水平饰带、阶梯楼冠。仍是一次会话。" },
  { id: "session-hotel", group: "会话楼", image: sessionHotel, title: "海滨酒店", kind: "data", source: "cityLayout hotelBlocks + cityHotelCrown", body: "落在海滨酒店地块上的会话楼铺满宽地块成为一栋酒店，部分带白色格栅屋顶冠。只有有会话落户时才出现。" },
  { id: "hero-tower", group: "会话楼", image: heroTower, title: "全城之最", kind: "data", source: "cityParts.buildHeroCrown", body: "本窗口 token 最多的那一次会话：楼顶加区色尖顶冠，黄昏与夜里顶上亮一道探照光柱，在全城一眼找到它。楼高仍由它自己的 token 决定。" },
  { id: "district-landmark", group: "地标", image: districtLandmark, title: "城区地标", kind: "scale", source: "cityParts.buildDistrictLandmarks", body: "每个执行环境城区在景观湖旁立一座三级收分的装饰艺术塔，取区色，城区标签立在它上方。每个会话加高一截，回放时随会话逐层加盖；点击查看该城区的会话、活跃与异常。" },
  { id: "twin-towers", group: "地标", image: twinTowers, title: "双子塔", kind: "decor", source: "cityParts.buildLandmarks", body: "迈阿密热带装饰艺术风格的城市地标：眉檐遮阳板、粉彩竖鳍、阶梯塔冠与霓虹勾边，夜里亮窗。由岛屿种子挑选，不代表会话。" },
  { id: "twist-tower", group: "地标", image: twistTower, title: "扭转塔", kind: "decor", source: "cityParts.buildLandmarks", body: "逐层扭转的粉彩塔楼，与双子塔二选一，构成市中心天际线。由岛屿种子挑选，不代表会话。" },
  { id: "tv-tower", group: "地标", image: tvTower, title: "电视塔", kind: "decor", source: "cityParts.buildLandmarks", body: "细高塔身加观景球舱与霓虹环，市中心的竖向标志。由岛屿种子挑选，不代表会话。" },
  { id: "villa", group: "地标", image: villa, title: "地中海庄园", kind: "decor", source: "cityLandmarkVilla.buildVillaComplex", body: "白灰泥墙、红陶屋顶、临水拱廊与钟塔的地中海复兴风格度假庄园，海滨城的固定地标。不代表会话。" },
  { id: "ferris-wheel", group: "地标", image: ferrisWheel, title: "摩天轮", kind: "decor", source: "cityParts.buildLandmarks", body: "海滨固定地标，轮盘缓慢旋转。不代表会话。" },
  { id: "sail-opera", group: "地标", image: sailOpera, title: "帆形歌剧院", kind: "decor", source: "cityParts.buildLandmarks", body: "白色壳体的文化建筑，立在海岸上。由岛屿种子挑选，不代表会话。" },
  { id: "arch", group: "地标", image: arch, title: "凯旋拱门", kind: "decor", source: "cityParts.buildLandmarks", body: "立在主干道旁的纪念拱门。由岛屿种子挑选，不代表会话。" },
  { id: "lighthouse", group: "地标", image: lighthouse, title: "灯塔", kind: "decor", source: "cityParts.buildLandmarks", body: "红白条纹的岬角灯塔，夜里亮灯。由岛屿种子挑选，不代表会话。" },
  { id: "pagoda", group: "地标", image: pagoda, title: "宝塔", kind: "decor", source: "cityParts.buildLandmarks", body: "多层出檐的塔，东亚风格岛屿更常见。由岛屿种子挑选，不代表会话。" },
  { id: "suspension-bridge", group: "桥与道路", image: suspensionBridge, title: "悬索桥", kind: "decor", source: "cityParts.buildLandmarks (suspension-bridge)", body: "最长的一座过河桥做成悬索桥：红色门式塔、主缆与吊索。道路照常通行。" },
  { id: "truss-bridge", group: "桥与道路", image: trussBridge, title: "桁架桥", kind: "decor", source: "cityParts.buildTrussBridges", body: "其余过河桥做成红色穿式桁架桥，工业年代风格，与悬索桥互补。道路照常通行。" },
  { id: "expressway", group: "桥与道路", image: expressway, title: "环线高架", kind: "decor", source: "cityParts.buildDistrictExpressways", body: "绕城市核心一圈的高架快速路，桥面、护栏、路灯与桥墩齐全，过河处连续跨越。属于城市骨架，不代表会话。" },
  { id: "civic-hall", group: "公共建筑", image: civicHall, title: "市政厅", kind: "decor", source: "cityParts.buildPublicSites (civic)", body: "核心环岛广场上的柱廊市政厅，青色穹顶。城市的中心节点，主干道从这里放射。不代表会话。" },
  { id: "station", group: "公共建筑", image: station, title: "车站", kind: "decor", source: "cityParts.buildPublicSites (station)", body: "带长雨棚与站台轨道的车站，紧邻主干道。不代表会话。" },
  { id: "stadium", group: "公共建筑", image: stadium, title: "体育场", kind: "decor", source: "cityParts.buildPublicSites (stadium)", body: "环形看台加红色立柱，内含草坪球场，夜里有泛光灯。不代表会话。" },
  { id: "observation-tower", group: "公共建筑", image: observationTower, title: "观景塔", kind: "decor", source: "cityParts.buildPublicSites (tower)", body: "细身观景塔，顶部圆形观景台与红色天线。不代表会话。" },
  { id: "park", group: "公共建筑", image: park, title: "城市公园", kind: "decor", source: "cityParts.buildPublicSites / cityTextures (park)", body: "椭圆草坪与环形园路，一圈路灯，林木由规划层种植。不代表会话。" },
  { id: "hospital", group: "公共建筑", image: hospital, title: "医院", kind: "scale", source: "cityParts.buildCivics (hospital)", body: "白色主楼加两翼，正反两面红十字，急诊入口带红色雨篷，屋顶停机坪。会话越多城市配套越多（约每 45 个会话一座），反映城市规模而非单个会话。" },
  { id: "school", group: "公共建筑", image: school, title: "学校", kind: "scale", source: "cityParts.buildCivics (school)", body: "U 形教学楼加红色跑道操场与旗杆。随城市规模出现，不代表单个会话。" },
  { id: "mall", group: "公共建筑", image: mall, title: "商场", kind: "scale", source: "cityParts.buildCivics (mall)", body: "大体量低层商场：玻璃中庭、屋顶停车场、招牌塔与临街入口。随城市规模出现，不代表单个会话。" },
  { id: "garden", group: "公共建筑", image: garden, title: "城区花园与景观湖", kind: "scale", source: "cityParts.buildGardens", body: "每个执行环境城区中心的花园与景观湖，城区地标立在它旁边；城区的会话楼从这里向外生长。有会话的城区才出现。" },
  { id: "harbor", group: "海滨与港口", image: harbor, title: "港口与码头", kind: "decor", source: "cityParts.buildPublicSites (harbor)+ buildMarina", body: "集装箱堆场、龙门吊、白色筒仓，以及伸入水面的游艇码头。属于岛屿规划的公共用地，不代表会话。" },
  { id: "airport", group: "海滨与港口", image: airport, title: "机场岛与堤道", kind: "decor", source: "cityAirport.buildAirport", body: "主岛外浅水区的填海机场：跑道与端头标线、壳形航站楼与登机桥、塔台，由一条多跨堤道连回主岛；夜里跑道边灯亮起。不代表会话。" },
  { id: "signs", group: "海滨与港口", image: signs, title: "广告牌", kind: "decor", source: "citySkylineProps (roadsideSignPlan / rooftopSignPlan)", body: "主干道旁的双柱广告牌与商业楼顶立牌，抽象色条加霓虹边框，不含文字。不代表会话。" },
  { id: "beach", group: "海滨与港口", image: beach, title: "海滨设施", kind: "decor", source: "cityParts.buildBeach* / buildPromenade / buildLifeguardTowers", body: "沙滩、遮阳伞与躺椅、沙排场、救生塔、粉色滨海步道与路灯。沿建成区附近的海岸铺设，不代表会话。" },
];

export const CATALOG_KIND_LABEL: Record<CatalogKind, string> = { data: "代表会话", scale: "随规模出现", decor: "装饰" };
export const CATALOG_GROUPS: CatalogGroup[] = ["会话楼", "地标", "桥与道路", "公共建筑", "海滨与港口"];
