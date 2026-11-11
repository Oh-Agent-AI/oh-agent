/**
 * 规划修复模式的交互状态机（docs/CITY_PLAN_MANUAL_REPAIR_SPEC.md §7.1 / §13.3）。
 *
 * 纯逻辑：不碰 three/DOM/引擎，依赖全部经 `RepairDeps` 注入——可以在 node 里直接测
 * （scripts/verify-plan-repair-controller.mjs），也让「点击/悬停 → 状态 → 反馈」这条链不依赖 WebGL 才能验证。
 *
 * 三个工具（参考游戏的建造交互）：
 *   选择（build）：点会话楼 → 候选空地块高亮 → 点地块搬过去；
 *   画路（draw）：点一下落起点，鼠标移动有预览（绿可行 / 红不行 + 原因），再点一下落笔，连续接着画；
 *   橡皮擦（erase）：悬停高亮将被擦掉的路段（红；不能擦的变灰并说明原因），点击擦除。
 *   设施（site）：悬停高亮非会话建筑（公共设施/花园/地标/市政用地/背景楼），点选后点目标空地搬家，或拆除。
 *   路口（node）：点一个路口拿起来，鼠标移动预览关联路段跟着走（含推平/安置后果），再点一下放下。
 * 画路有五种路型（SPEC §17）：小路 5 / 次干道 8 / 主干道 12 / 滨海大道（12，铺滨海景观带）/ 高架（逐点折线，回车或双击完成）。
 * 从路尽头接着画并拐弯时，拐角自动倒圆（预览按实际铺成的弧线画）。
 * 选中建筑后悬停有落位试算（绿 = 能放，红 = 不能放并写原因）；画路/拖路口的推平与安置是推土机试算的确切结果（SPEC §16）。
 * 画路/橡皮擦只用地面点（引擎射线与地形的交点），不看射线先打到的建筑——与悬停预览用的是同一个点，所见即所点。
 */
import { roadWidthFor } from "../engine/roadStandard";
import type { SnapPoint, RoadVerdict } from "../engine/planRoadRules";
import type { Vec2 } from "../engine/cityLayout";
import type { RepairRay } from "../engine/CityEngine";
import type { SiteInfo, SiteTarget } from "../engine/planSites";
import type { BridgeFixProposal, BridgeFixResult } from "../engine/planBridgeFix";
import type { EditResult, ImpactPreview, NodeHandle, PlacementGhost, PlanRect, RepairCandidate, RoadPreview, RoadPurpose, SiteEditResult } from "./session";

export type RepairTool = "build" | "draw" | "erase" | "restyle" | "site" | "node" | "drive";
/** 试驾结果（planRepair/testDrive.ts 的面板视图）。 */
export type DriveReport = { verdict: "passed" | "blocked" | "undetermined"; path: Vec2[]; width: number; blockedAt: Vec2 | null; reason: string; kind: "bridge" | "road" };
/** 画路的路型：地面路三档宽度 + 滨海大道 + 高架。 */
export type RoadType = "local" | "secondary" | "main" | "waterfront" | "viaduct";
export type DrawMode = "straight" | "curve";
export const ROAD_SPEC: Record<Exclude<RoadType, "viaduct">, { width: number; purpose?: RoadPurpose }> = {
  local: { width: roadWidthFor("local") }, secondary: { width: roadWidthFor("collector") }, main: { width: roadWidthFor("arterial") }, waterfront: { width: roadWidthFor("arterial"), purpose: "waterfront" },
};

const ROAD_TYPE_LABEL: Record<RoadType, string> = { local: "小路", secondary: "次干道", main: "主干道", waterfront: "滨海大道", viaduct: "高架" };

export type RepairMessage = { kind: "hint" | "ok" | "warn" | "error"; text: string };

/** 悬停预览（叠加层据此画色带/标记）。reason 非空时面板在消息下方显示。 */
export type RepairPreview =
  | { kind: "erase"; points: Vec2[]; width: number; ok: boolean; reason: string | null; warning: string | null }
  /** 一键修复方案（P1-D）：将擦掉的整座桥与残路（红）+ 将画的直桥（绿）。 */
  | { kind: "proposal"; erase: Vec2[][]; draw: { from: Vec2; to: Vec2; width: number } }
  /** 试驾：悬停的路/整座桥（蓝）；点过之后是试驾结果（通过绿 / 挡住处红点 / 未判定琥珀）。 */
  | { kind: "drive"; points: Vec2[]; width: number; result: DriveReport["verdict"] | null; blockedAt: Vec2 | null }
  /** 改路型：鼠标下那条路的一整段（按目标宽度画）。 */
  | { kind: "restyle"; edges: Array<{ points: Vec2[]; width: number }>; ok: boolean; reason: string | null; warning: string | null; impact: ImpactPreview | null; waterfront: boolean }
  | { kind: "draw"; from: Vec2; to: Vec2; width: number; ok: boolean; reason: string | null; warning: string | null; snap: SnapPoint; impact: ImpactPreview | null; /** 实际铺成的折线（拐角倒圆）；null = 直线 from→to */ path: Vec2[] | null; waterfront: boolean }
  /** 高架：已点下的点 + 鼠标位置。 */
  | { kind: "viaduct"; points: Vec2[]; ok: boolean; reason: string | null; warning: string | null; impact: ImpactPreview | null }
  | { kind: "snap"; at: Vec2; ok: boolean; snap: SnapPoint }
  | { kind: "site"; rect: { x: number; z: number; yaw: number; width: number; depth: number }; label: string }
  /** 选中建筑后悬停的落位试算。 */
  | { kind: "ghost"; rect: PlanRect; ok: boolean; reason: string | null; warning: string | null }
  /** 路口工具：悬停指向的路口（还没拿起）。 */
  | { kind: "node-hover"; at: Vec2; ok: boolean; reason: string | null }
  /** 路口工具：拿起路口后，关联路段跟到鼠标位置的样子。 */
  | { kind: "node"; at: Vec2; edges: Array<{ points: Vec2[]; width: number }>; ok: boolean; reason: string | null; warning: string | null; impact: ImpactPreview | null }
  | null;

export type RepairState = {
  active: boolean;
  tool: RepairTool;
  buildingId: string | null;
  candidates: RepairCandidate[];
  /** 设施工具：选中的设施与它的合法目标（街区/地块）。 */
  site: SiteInfo | null;
  siteTargets: SiteTarget[];
  drawStart: SnapPoint | null;
  /** 路口工具：拿在手上的路口。 */
  dragNode: NodeHandle | null;
  /** 刚搬走的地标/市政用地在原址留下的断头接入路（面板给一键擦掉）。 */
  stranded: string[];
  /** 正在预览的一键修复方案（P1-D）：采用前不写补丁；Esc / 换工具放弃。 */
  proposal: BridgeFixProposal | null;
  roadType: RoadType;
  /** 高架：已点下、还没完成的折线点。 */
  viaduct: Vec2[];
  /** 地面路的画法：直线（两点）/ 弧线（起点 → 经过点 → 终点）。 */
  drawMode: DrawMode;
  /** 弧线：已点下的经过点（起点之后、终点之前）。 */
  drawVia: Vec2 | null;
  /** 自由级设施落位时用户额外转的 90° 次数（[ / ] 键）；自动朝向是「正门朝最近的路」。 */
  siteTurn: number;
  preview: RepairPreview;
  message: RepairMessage | null;
};

export type RepairDeps = {
  isSessionBuilding(id: string): boolean;
  candidates(buildingId: string): RepairCandidate[];
  nearestParcel(x: number, z: number): { id: string } | null;
  parcelOf(buildingId: string): string | null;
  moveBuilding(buildingId: string, parcelId: string): EditResult;
  /** 选中环（引擎的选中高亮）；null 取消。 */
  setSelected(id: string | null): void;
  // 道路
  snap(x: number, z: number): SnapPoint | null;
  edgeAt(x: number, z: number): { id: string; points: Vec2[]; width: number; locked: boolean } | null;
  validateAdd(from: Vec2, to: Vec2, width: number, purpose?: RoadPurpose, exact?: boolean, via?: Vec2): RoadPreview;
  addRoad(from: Vec2, to: Vec2, width: number, purpose?: RoadPurpose, via?: Vec2): EditResult;
  // 高架
  validateHighway(points: readonly Vec2[], exact?: boolean): RoadPreview;
  addHighway(points: readonly Vec2[]): EditResult;
  highwayAt(x: number, z: number): { points: Vec2[]; width: number } | null;
  cutHighway(x: number, z: number): EditResult;
  highwayEndAt(x: number, z: number): Vec2 | null;
  validateDrop(edgeId: string): RoadVerdict;
  /** 改路型（路线图 P1-4）：鼠标下那条路的一整段 + 改成目标路型的校验；变宽且 exact 时含推土机试算。 */
  restyleAt(x: number, z: number, width: number, purpose?: RoadPurpose, exact?: boolean): { edges: Array<{ points: Vec2[]; width: number }>; verdict: RoadPreview } | null;
  restyleRoad(edgeId: string, width: number, purpose?: RoadPurpose): EditResult;
  dropEdge(edgeId: string): EditResult;
  dropEdges(edgeIds: readonly string[]): EditResult;
  /** 试驾（P1-E）：沿这条路/整座桥双向各开一遍。null = 这里没有可试驾的路（太短）。 */
  testDrive(edgeId: string): DriveReport | null;
  /** 坏桥头的一键修复（P1-D）：候选方案（不写补丁）与采用（一步写入、一步撤销）。 */
  proposeBridgeFix(deckId: string): BridgeFixResult;
  applyBridgeFix(proposal: BridgeFixProposal): EditResult;
  // 路口
  nodeAt(x: number, z: number): NodeHandle | null;
  validateMove(nodeId: string, x: number, z: number, exact?: boolean): RoadPreview;
  moveNode(nodeId: string, x: number, z: number): EditResult;
  // 落位试算（悬停）
  buildingGhost(buildingId: string, x: number, z: number): PlacementGhost | null;
  siteGhost(site: SiteInfo, x: number, z: number, turn?: number): PlacementGhost | null;
  // 设施
  pickSite(ray: RepairRay): SiteInfo | null;
  siteById(id: string): SiteInfo | null;
  siteTargets(site: SiteInfo): SiteTarget[];
  siteTargetAt(site: SiteInfo, x: number, z: number, turn?: number): string | null;
  moveSite(site: SiteInfo, targetId: string): SiteEditResult;
  removeSite(site: SiteInfo): EditResult;
  /**
   * 推迟执行（返回取消函数）。提供时，画路/拖路口/高架的悬停预览在鼠标移动中只给估计，停住 HOVER_SETTLE_MS 后再跑推土机试算
   * （4000 楼一次试算 ~50 ms，跟着鼠标每帧跑会掉帧——路线图 SPEC P0-1）。不提供（测试）时始终同步给确切结果。
   */
  defer?(run: () => void, ms: number): () => void;
};

const BLOCKER_TEXT: Record<string, string> = {
  // 移楼
  "parcel-occupied": "该地块已被其他会话楼、配套或背景楼占用",
  "building-over-road": "楼会压到道路上",
  "building-overlap": "会和其他会话楼重叠",
  "steep-slope": "地块坡度太陡",
  "not-buildable": "该处不可建设（水面或岩岸）",
  "highway-clearance": "高架净空不足",
  "missing-parcel": "地块不存在（城市已重排）",
  "unknown-building": "这栋楼不在当前城市里",
  // 道路
  "non-standard-width": "道路宽度不符合标准：请选择支路、次干道或主干道",
  "locked-edge": "桥面由桥梁模型绑定，不能单独编辑（橡皮擦可以整座擦掉）",
  "hits-locked-site": "会压到悬索桥（它是路网里的一段桥面）",
  "site-locked": "这座设施已锁定",
  "arterial-skeleton": "主干道是城市骨架，不能擦",
  "strands-buildings": "擦掉后有楼离最近的路超过 40",
  "disconnects-buildings": "擦掉后有楼会和路网断开",
  "edge-too-short": "太短了（至少 6）",
  "edge-too-long": "太长了（最多 800）",
  "isolated-road": "新路必须接到现有道路上",
  "curve-too-tight": "弯太急：小路最小转弯半径 15、次干道 24、主干道 36——把经过点挪得离起终点连线近一些",
  "curve-over-water": "弧线不能过水——过河请切回直线画（会自动架桥）",
  "road-in-water": "不能修到水面或岩岸上（起点或终点在水里，或一笔要跨两段水——地面桥一笔只跨一段水面）",
  "bridge-too-long": "水面太宽，地面桥最长 160——请改用高架",
  "junction-on-bridge": "桥上不能有路口：新路会在水面上和别的路交叉",
  "bridge-approach-short": "桥头离路口或落笔点太近：桥两端各要一段直引道（小路 14、次干道 16、主干道 18）——把起点/终点往岸上多拉一点，别在桥头附近穿过别的路",
  "bridge-approach-steep": "桥头岸坡太陡，车开不上桥——换个岸坡缓的地方过河",
  "road-too-steep": "太陡了：坡比超过车的爬坡上限 0.31，车开不上去——换条缓一点的线，或用弧线绕着坡走",
  "road-over-building": "会穿过建筑、配套或花园",
  "crosses-road": "与现有道路交叉——请在交叉点连接",
  "acute-junction": "路口夹角太小（小于 30°）",
  "surface-unresolved": "这样接会在路口留下一块车开不上去的路面（驾驶面解不出）——换个接入点或角度",
  "junction-too-sharp": "路口夹角太小（小于 50°）：车拐不过来——请接近直角接入，或先接到别处再拐",
  "edge-exists": "这里已经有路了",
  degenerate: "起点和终点是同一个路口",
  "node-collision": "目标处已有路口",
  "missing-edge": "路段不存在",
  "missing-node": "路口不存在",
  unchanged: "位置没有变化",
  "city-not-ready": "城市尚未就绪",
  // 设施
  "target-occupied": "目标已被占用（会话楼、配套、花园或背景楼）",
  "site-over-road": "会压到道路上",
  "does-not-fit": "这块街区的真实形状装不下它（会越出街区边界或压到街区里的空地/水塘）",
  "missing-target": "这里没有可落位的街区或地块",
  "viaduct-too-short": "高架太短（至少 30）",
  "viaduct-end-in-water": "匝道落地点在水里——高架两端要落在陆地上，或接到已有高架上",
  "missing-highway": "这里没有高架",
  "tier-changed": "城市已随数据增长扩大了一档，旧修改已失效——请先在面板上点「清除失效修改」",
  "generator-changed": "城市生成规则更新了，旧修改已失效——请先在面板上点「清除失效修改」",
};
const WARNING_TEXT: Record<string, string> = {
  "cross-district": "已搬出它所属的小区",
  "creates-dead-end": "会留下一个断头路",
  "far-move": "移动距离很远",
  // 放权后（SPEC §15）由拒绝改为提示的
  "erases-arterial": "擦掉的是主干道",
  "erases-waterfront": "擦掉的是滨海路",
  "cuts-bridge": "擦掉桥头引道后，桥会和路网断开",
  "erases-bridge": "将擦掉整座桥——桥头两侧的路留作断头，可以用画路工具重画一座直桥",
  "erases-suspension-bridge": "将擦掉整座悬索桥（塔架与主缆一起拆）——桥头两侧的路留作断头，可以用画路工具重画一座直桥",
  "strands-buildings": "有楼会离最近的路超过 40（楼还在，只是没有路通到）",
  "disconnects-buildings": "有楼会和主路网断开",
  "isolated-road": "这段路两端都没接上路网",
  "acute-junction": "会形成夹角小于 30° 的路口",
  "no-access-road": "新位置附近没有能顺手接上的路（会压到建筑或入水），需要你用画路工具接一条",
  "short-viaduct": "不到 180，桥面升不到全高（两端各要 90 的匝道）",
  "joins-viaduct": "将接上已有高架（接缝处不落地）",
  "cuts-viaduct": "高架会断成两条，断口各自落地成匝道",
  "far-from-coast": "离海岸较远——滨海景观带会铺在离海近的一侧",
  "drops-waterfront": "改掉的是滨海路——沿路的滨海景观带会撤掉",
  "narrows-arterial": "主干道会变窄",
  "bridge-under-viaduct": "桥的上方有高架（净空请自己看一眼）",
  "road-steep": "这条路很陡（坡比超过 0.2），车开得上去但很吃力",
};
/** 带数量的提示码（`code:N`）。 */
const COUNTED_TEXT: Record<string, (n: number) => string> = {
  "auto-junction": (n) => `将在交叉处自动生成 ${n} 个路口`,
  bulldoze: (n) => `将推平 ${n} 座设施`,
  relocate: (n) => `将由开发商就近安置 ${n} 栋会话楼`,
  bulldozed: (n) => `推平了 ${n} 座设施`,
  relocated: (n) => `开发商安置了 ${n} 栋会话楼`,
  homeless: (n) => `${n} 栋会话楼附近没有空地块，仍压在路上`,
  "homeless-risk": (n) => `${n} 栋会话楼附近没有空地块，会留在路上`,
  "access-road": (n) => `在新位置补了一条 ${n} 长的接入路`,
  bridge: (n) => `水面段将架成一座 ${n} 长的桥`,
};

export const blockerText = (code: string): string =>
  code.startsWith("patch-tier-") ? BLOCKER_TEXT["tier-changed"] : code.startsWith("patch-generator-") ? BLOCKER_TEXT["generator-changed"] : BLOCKER_TEXT[code] ?? code;
/** 一键修复找不到方案时的拒因（planBridgeFix 的 `codes`）：搜索里的拒因码说短话；其余阻断码走 blockerText。 */
const FIX_REFUSAL_TEXT: Record<string, string> = {
  "no-road-on-bank": "有一岸附近没有能接上的路",
  "no-water": "试过的落笔都不跨水",
  "bridge-approach-steep": "岸坡太陡",
  "bridge-approach-short": "桥头离路口太近",
  "road-in-water": "落笔点在水里，或一笔要跨两段水",
  "bridge-too-long": "水面太宽，地面桥架不过去",
  "junction-on-bridge": "桥面会穿过别的路",
  "road-too-steep": "引道太陡",
  "junction-too-sharp": "接入的路口夹角太小",
};
const bridgeFixRefusalText = (result: { reason: string; codes: string[] }): string => {
  if (result.reason === "no-redraw") return `附近找不到一笔合法的直桥（${result.codes.map((code) => FIX_REFUSAL_TEXT[code] ?? blockerText(code)).join("；") || "没有可试的落笔点"}）`;
  return result.codes.length ? `这座桥擦不掉（${result.codes.map(blockerText).join("；")}）` : "这里已经不是桥面了";
};
/** 编辑失败的说明：优先逐条翻译阻断码，其次翻译 reason（跨档的补丁会以 reason 形式回来）。 */
const failText = (verb: string, result: { reason: string; blockers?: string[] }) =>
  `${verb}：${result.blockers?.length ? result.blockers.map(blockerText).join("；") : blockerText(result.reason)}`;
export const warningText = (code: string): string => {
  const [key, count] = code.split(":");
  return count !== undefined && COUNTED_TEXT[key] ? COUNTED_TEXT[key](Number(count)) : WARNING_TEXT[code] ?? code;
};

const noteOfVerdict = (verdict: RoadPreview) => { const note = noteOf(verdict.warnings); return note && verdict.estimate ? `${note}${ESTIMATE_NOTE}` : note; };
const reasonOf = (blockers: readonly string[]) => (blockers.length ? blockers.map(blockerText).join("；") : null);
const noteOf = (warnings: readonly string[]) => (warnings.length ? warnings.map(warningText).join("；") : null);

const HINT: Record<RepairTool, RepairMessage> = {
  build: { kind: "hint", text: "点选任意建筑（会话楼、设施、地标、市政用地），再点要搬去的空地" },
  draw: { kind: "hint", text: "点一下落起点（会吸附到路口或路面），再点一下落笔；可连续画，拐弯自动倒圆。结束：右键、再点一下终点或 Esc" },
  erase: { kind: "hint", text: "把橡皮擦移到道路上，红色高亮的路段点击即擦掉" },
  restyle: { kind: "hint", text: "先选路型，再把鼠标移到路上：整条街高亮，点一下就改成这个路型（变宽会推平/安置两侧的楼；桥面不能改）" },
  site: { kind: "hint", text: "点选任意非会话建筑（公共设施、花园、地标、市政用地、背景楼）；再点空地搬家，或点「拆除」" },
  node: { kind: "hint", text: "点一个路口拿起来，移动鼠标预览，再点一下放下；Esc 放回原处" },
  drive: { kind: "hint", text: "点一条路或一座桥试驾：车沿它来回各开一遍，告诉你开不开得过去" },
};

const DRIVE_CAUSE: Array<[RegExp, string]> = [
  [/unsupported-footprint|no-surface/, "车轮悬空：路面在这里接不上"],
  [/excessive-step|wheel-twist|step/, "台阶太高或车轮别住：路面在这里有高差"],
  [/curb|sidewalk|island/, "撞上路缘：路在这里太窄或拐得太急"],
  [/grade|slope|climb/, "坡太陡：车爬不上去"],
];
const driveCause = (reason: string) => DRIVE_CAUSE.find(([pattern]) => pattern.test(reason))?.[1] ?? reason;
function driveMessage(report: DriveReport): RepairMessage {
  const what = report.kind === "bridge" ? "这座桥" : "这条路";
  if (report.verdict === "passed") return { kind: "ok", text: `试驾通过：车沿${what}来回都开得过去` };
  if (report.verdict === "blocked") return { kind: "error", text: `试驾挡住：车在红点处过不去（${driveCause(report.reason)}）——${report.kind === "bridge" ? "可以整座擦掉重画一座直桥" : "可以擦掉绕开重画"}` };
  return { kind: "warn", text: `试驾未判定：这次没开完（${driveCause(report.reason)}），不代表路不通` };
}

// 名称表暂在这里（注册表 SPEC CITY_SITE_REGISTRY_SPEC.md B1 会把它们收进 siteClasses 单一来源）。
const SITE_LABEL: Record<string, string> = { school: "学校", mall: "商场", hospital: "医院", garden: "城区花园与景观湖", "district-landmark": "城区地标", context: "背景楼" };
const LANDMARK_LABEL: Record<string, string> = { "tv-tower": "电视塔", "sail-opera": "帆形歌剧院", arch: "凯旋拱门", pagoda: "宝塔", lighthouse: "灯塔", "ferris-wheel": "摩天轮", "suspension-bridge": "悬索桥", "twin-towers": "双子塔", "twist-tower": "扭转塔", "villa-complex": "地中海庄园", "islet-mansion": "豪宅岛庄园", "islet-grounds": "豪宅岛场地" };
const PUBLIC_LABEL: Record<string, string> = { civic: "市政厅", station: "车站", stadium: "体育场", park: "城市公园", tower: "观景塔", harbor: "港口与码头" };
export const siteLabel = (site: Pick<SiteInfo, "kind" | "civicKind" | "landmarkKind" | "publicKind">): string =>
  site.kind === "civic" ? SITE_LABEL[site.civicKind ?? ""] ?? "公共设施"
    : site.kind === "landmark" ? LANDMARK_LABEL[site.landmarkKind ?? ""] ?? "地标"
      : site.kind === "public-site" ? PUBLIC_LABEL[site.publicKind ?? ""] ?? "市政用地"
        : SITE_LABEL[site.kind] ?? site.kind;
/** 设施占地的朝向矩形（free 级是模型占地的包围盒，见 planSites.siteBox；控制器只拿类型，不引规则模块）。 */
const siteRect = (site: SiteInfo) => site.box ?? { x: site.x, z: site.z, yaw: site.yaw, width: site.width, depth: site.depth };
/** 地面点是否落在设施占地（包围盒）内。 */
const footprintContains = (site: SiteInfo, p: Vec2) => {
  const box = siteRect(site);
  const dx = p.x - box.x; const dz = p.z - box.z;
  const lx = dx * Math.cos(box.yaw) - dz * Math.sin(box.yaw); const lz = dx * Math.sin(box.yaw) + dz * Math.cos(box.yaw);
  return Math.abs(lx) <= box.width / 2 && Math.abs(lz) <= box.depth / 2;
};

const CURVE_HINT: RepairMessage = { kind: "hint", text: "弧线：点起点，再点路要经过的点，最后点终点；可连续画，Esc 撤回上一步，C 切回直线" };
const CURVE_START_HINT: RepairMessage = { kind: "hint", text: "起点已落下：点一下路要经过的地方（弧线会穿过它）" };
const DRAW_DONE: RepairMessage = { kind: "ok", text: "已结束这条路线，可以点新的起点" };
const VIADUCT_HINT: RepairMessage = { kind: "hint", text: "高架：逐点点击画折线（可跨河、跨路），回车或在最后一点上再点一下完成；Esc 撤回上一个点" };
/** 通用的「这个工具怎么用」提示（工具切换/取消选中时回到的那条），区别于选中结果等针对当前操作的提示。 */
export const isGenericHint = (message: RepairMessage | null): boolean =>
  !!message && (Object.values(HINT).includes(message) || message === CURVE_HINT || message === CURVE_START_HINT || message === VIADUCT_HINT);

const ghostPreview = (ghost: PlacementGhost | null): RepairPreview =>
  ghost ? { kind: "ghost", rect: ghost.rect, ok: ghost.blockers.length === 0, reason: ghost.blockers[0] === "unchanged" ? "它已经在这里了" : reasonOf(ghost.blockers), warning: noteOf(ghost.warnings) } : null;
/** 把路段朝向路口的一端换成 to（拖路口预览）。 */
const movedEdges = (node: NodeHandle, to: Vec2) => node.edges.map((edge) => {
  const points = [...edge.points];
  if (edge.atStart) points[0] = to; else points[points.length - 1] = to;
  return { points, width: edge.width };
});

const HOVER_EPS = 0.75;
const HOVER_SETTLE_MS = 150;
const ESTIMATE_NOTE = "（预估，鼠标停住后给出确切结果）"; // 地面点移动不到这么多就不重算预览（鼠标抖动）

export class RepairController {
  private state: RepairState = { active: false, tool: "build", buildingId: null, candidates: [], site: null, siteTargets: [], drawStart: null, dragNode: null, stranded: [], proposal: null, roadType: "local", viaduct: [], drawVia: null, drawMode: "straight", siteTurn: 0, preview: null, message: null };
  private readonly listeners = new Set<(state: RepairState) => void>();
  private lastGround: Vec2 | null = null;
  private lastRay: RepairRay | null = null;
  /** 鼠标停住了：悬停预览可以跑确切的推土机试算。没有 defer 时恒为真。 */
  private settled = true;
  private cancelSettle: (() => void) | null = null;

  constructor(private readonly deps: RepairDeps) {}

  get snapshot(): RepairState {
    return this.state;
  }

  subscribe(listener: (state: RepairState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private set(next: Partial<RepairState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }

  enter(): void {
    if (this.state.active) return;
    this.lastGround = null;
    this.set({ active: true, tool: "build", buildingId: null, candidates: [], site: null, siteTargets: [], drawStart: null, dragNode: null, stranded: [], viaduct: [], drawVia: null, preview: null, message: HINT.build });
  }

  exit(): void {
    if (!this.state.active) return;
    this.cancelSettle?.(); this.cancelSettle = null; this.settled = true;
    this.deps.setSelected(null);
    this.lastGround = null;
    this.set({ active: false, buildingId: null, candidates: [], site: null, siteTargets: [], drawStart: null, dragNode: null, stranded: [], viaduct: [], drawVia: null, preview: null, message: null });
  }

  setTool(tool: RepairTool): void {
    if (!this.state.active || this.state.tool === tool) return;
    this.deps.setSelected(null);
    this.lastGround = null;
    this.set({ tool, buildingId: null, candidates: [], site: null, siteTargets: [], drawStart: null, dragNode: null, stranded: [], proposal: null, viaduct: [], drawVia: null, preview: null, message: tool === "draw" && this.state.roadType === "viaduct" ? VIADUCT_HINT : HINT[tool] });
  }

  /** 换路型。地面路之间互换保留起点（接着画、只换宽度）；进出高架清掉进行中的笔画（两种画法不一样）。 */
  setRoadType(roadType: RoadType): void {
    if (!this.state.active || this.state.roadType === roadType) return;
    const crossing = (roadType === "viaduct") !== (this.state.roadType === "viaduct");
    this.set({ roadType, ...(crossing ? { drawStart: null, viaduct: [], message: this.state.tool === "draw" ? (roadType === "viaduct" ? VIADUCT_HINT : HINT.draw) : this.state.message } : {}) });
    this.recomputePreview();
  }

  /** 切换地面路画法（直线 / 弧线，C 键）。保留起点，丢掉弧线经过点。 */
  setDrawMode(drawMode: DrawMode): void {
    if (!this.state.active || this.state.drawMode === drawMode) return;
    this.set({ drawMode, drawVia: null, ...(this.state.tool === "draw" && this.state.roadType !== "viaduct" ? { message: drawMode === "curve" ? (this.state.drawStart ? CURVE_START_HINT : CURVE_HINT) : HINT.draw } : {}) });
    this.recomputePreview();
  }

  /** 高架：完成当前折线（回车 / 在最后一点上再点一下）。 */
  finishViaduct(): void {
    const { active, tool, roadType, viaduct } = this.state;
    if (!active || tool !== "draw" || roadType !== "viaduct") return;
    if (viaduct.length < 2) { this.set({ message: { kind: "warn", text: "高架至少要两个点：再点一个点" } }); return; }
    const result = this.deps.addHighway(viaduct);
    if (!result.ok) { this.set({ message: { kind: "error", text: failText("不能这样架", result) } }); return; }
    const warnings = result.warnings.map(warningText);
    this.set({ viaduct: [], message: { kind: warnings.length ? "warn" : "ok", text: warnings.length ? `已架好一条高架（${warnings.join("；")}）` : "已架好一条高架" } });
    this.recomputePreview();
  }

  /** Esc：画路——先放弃当前起点，没有起点就回到选择工具；选择/橡皮擦——先取消选中，再退出模式。 */
  cancel(keepActive = false): void {
    const { active, tool, buildingId, drawStart } = this.state;
    if (!active) return;
    if (this.state.proposal) { this.set({ proposal: null, preview: null, message: { kind: "hint", text: "已放弃修复方案" } }); return; }
    if (tool === "draw" && this.state.viaduct.length) {
      const viaduct = this.state.viaduct.slice(0, -1);
      this.set({ viaduct, message: viaduct.length ? { kind: "hint", text: `已撤回一个点（还有 ${viaduct.length} 个）` } : VIADUCT_HINT });
      this.recomputePreview(); return;
    }
    if (tool === "draw" && this.state.drawVia) { this.set({ drawVia: null, message: CURVE_START_HINT }); this.recomputePreview(); return; }
    if (tool === "draw" && drawStart) { this.set({ drawStart: null, preview: null, message: HINT.draw }); this.recomputePreview(); return; }
    if (tool === "node" && this.state.dragNode) { this.set({ dragNode: null, preview: null, message: HINT.node }); this.recomputePreview(); return; }
    if (tool === "site" && this.state.site) { this.clearSite(HINT.site); return; }
    if (tool !== "build") { this.setTool("build"); return; }
    if (buildingId) { this.deselect(HINT.build); return; }
    if (!keepActive) this.exit();
  }

  /** 右键：和 Esc 一样逐级退一步（放弃起点 / 回到选择工具 / 取消选中），但绝不退出修复模式——误触右键不该关掉编辑器。 */
  back(): void { this.cancel(true); }

  private deselect(message: RepairMessage | null): void {
    this.deps.setSelected(null);
    this.set({ buildingId: null, candidates: [], preview: null, message });
  }

  private select(buildingId: string, message?: RepairMessage): void {
    const candidates = this.deps.candidates(buildingId);
    this.deps.setSelected(buildingId);
    this.set({
      buildingId, candidates,
      message: message ?? (candidates.length
        ? { kind: "hint", text: `已选中，附近有 ${candidates.length} 个可搬去的空地块（绿色）；点任一地块搬过去` }
        : { kind: "warn", text: "已选中，但附近没有可搬去的空地块" }),
    });    this.recomputePreview();
  }

  // ── 悬停预览（画路/橡皮擦）──────────────────────────────────────────────

  /** 引擎的指针移动：ground = 射线与地形的交点，鼠标离开/朝天为 null。 */
  hover(ground: Vec2 | null, ray: RepairRay | null = null): void {
    if (!this.state.active || this.state.proposal) return; // 预览方案时地图上只画方案
    if (!ground) { this.lastGround = null; this.lastRay = null; if (this.state.preview) this.set({ preview: null }); return; }
    if (this.lastGround && Math.hypot(ground.x - this.lastGround.x, ground.z - this.lastGround.z) < HOVER_EPS) return;
    this.lastGround = ground; this.lastRay = ray;
    if (this.deps.defer) {
      this.cancelSettle?.();
      this.settled = false;
      this.cancelSettle = this.deps.defer(() => { this.cancelSettle = null; this.settled = true; if (this.state.active) this.recomputePreview(); }, HOVER_SETTLE_MS);
    }
    this.recomputePreview();
  }

  /** 状态变了（工具/宽度/起点/擦除成功）但鼠标没动：用最后的地面点重算预览。 */
  private recomputePreview(): void {
    const ground = this.lastGround;
    const { tool, drawStart, roadType } = this.state;
    if (!ground) { if (this.state.preview) this.set({ preview: null }); return; }
    if (tool === "build") {
      const { buildingId } = this.state;
      const preview = buildingId ? ghostPreview(this.deps.buildingGhost(buildingId, ground.x, ground.z)) : null;
      if (preview || this.state.preview) this.set({ preview });
      return;
    }
    if (tool === "site") {
      // 设施拾取按射线与占地盒求交（实例级）：高楼会把射线与地形的交点推到楼后面，只用地面点会点歪。
      const hit = this.lastRay ? this.deps.pickSite(this.lastRay) : null;
      const site = this.state.site;
      // 已选中一座：指着别的设施（地面点在它占地内）就高亮它（点击会改选），否则是在找落脚处——给落位试算。
      if (site && !(hit && hit.id !== site.id && footprintContains(hit, ground))) { this.set({ preview: ghostPreview(this.deps.siteGhost(site, ground.x, ground.z, this.state.siteTurn)) }); return; }
      this.set({ preview: hit ? { kind: "site", rect: siteRect(hit), label: siteLabel(hit) } : null });
      return;
    }
    if (tool === "node") {
      const node = this.state.dragNode;
      if (!node) {
        const near = this.deps.nodeAt(ground.x, ground.z);
        this.set({ preview: near ? { kind: "node-hover", at: { x: near.x, z: near.z }, ok: !near.locked, reason: near.locked ? blockerText("locked-edge") : null } : null });
        return;
      }
      const verdict = this.deps.validateMove(node.id, ground.x, ground.z, this.settled);
      this.set({ preview: { kind: "node", at: ground, edges: movedEdges(node, ground), ok: verdict.blockers.length === 0, reason: reasonOf(verdict.blockers.filter((code) => code !== "unchanged")), warning: noteOfVerdict(verdict), impact: verdict.impact ?? null } });
      return;
    }
    if (tool === "erase") {
      // 高架在上面、看得见：鼠标在桥面范围内优先擦高架。
      const deck = this.deps.highwayAt(ground.x, ground.z);
      if (deck) { this.set({ preview: { kind: "erase", points: deck.points, width: deck.width, ok: true, reason: null, warning: warningText("cuts-viaduct") } }); return; }
      const edge = this.deps.edgeAt(ground.x, ground.z);
      if (!edge) { this.set({ preview: null }); return; }
      const verdict = this.deps.validateDrop(edge.id);
      this.set({ preview: { kind: "erase", points: edge.points, width: edge.width, ok: verdict.blockers.length === 0, reason: reasonOf(verdict.blockers), warning: noteOf(verdict.warnings) } });
      return;
    }
    if (tool === "drive") {
      const edge = this.deps.edgeAt(ground.x, ground.z);
      // 刚试驾过的那条路保留结果，直到鼠标移到别的路上。
      if (this.state.preview?.kind === "drive" && this.state.preview.result && edge && this.driveShown === edge.id) return;
      this.driveShown = null;
      this.set({ preview: edge ? { kind: "drive", points: edge.points, width: edge.width, result: null, blockedAt: null } : null });
      return;
    }
    if (tool === "restyle") {
      if (roadType === "viaduct") { if (this.state.preview) this.set({ preview: null }); return; }
      const spec = ROAD_SPEC[roadType];
      const hit = this.deps.restyleAt(ground.x, ground.z, spec.width, spec.purpose, this.settled);
      if (!hit) { this.set({ preview: null }); return; }
      const { verdict } = hit;
      const unchanged = verdict.blockers.includes("unchanged");
      this.set({ preview: { kind: "restyle", edges: hit.edges, ok: verdict.blockers.length === 0, reason: unchanged ? "这条路已经是这个路型了" : reasonOf(verdict.blockers), warning: noteOfVerdict(verdict), impact: verdict.impact ?? null, waterfront: spec.purpose === "waterfront" } });
      return;
    }
    if (roadType === "viaduct") {
      const at = this.deps.highwayEndAt(ground.x, ground.z) ?? ground;
      const points = [...this.state.viaduct, at];
      if (points.length < 2) { this.set({ preview: { kind: "viaduct", points, ok: true, reason: null, warning: this.deps.highwayEndAt(ground.x, ground.z) ? warningText("joins-viaduct") : null, impact: null } }); return; }
      const verdict = this.deps.validateHighway(points, this.settled);
      this.set({ preview: { kind: "viaduct", points, ok: verdict.blockers.length === 0, reason: reasonOf(verdict.blockers), warning: noteOfVerdict(verdict), impact: verdict.impact ?? null } });
      return;
    }
    const snap = this.deps.snap(ground.x, ground.z);
    if (!snap) { this.set({ preview: null }); return; }
    if (!drawStart) {
      this.set({ preview: { kind: "snap", at: { x: snap.x, z: snap.z }, ok: !snap.locked, snap } });
      return;
    }
    const spec = ROAD_SPEC[roadType];
    if (this.state.drawMode === "curve" && !this.state.drawVia) {
      // 弧线第二点（经过点）还没定：先画一条起点到鼠标的细引导线，不校验。
      this.set({ preview: { kind: "draw", from: { x: drawStart.x, z: drawStart.z }, to: ground, width: spec.width, ok: true, reason: null, warning: null, snap, impact: null, path: null, waterfront: spec.purpose === "waterfront" } });
      return;
    }
    const via = this.state.drawMode === "curve" ? this.state.drawVia ?? undefined : undefined;
    const verdict: RoadPreview = snap.locked ? { blockers: ["locked-edge"], warnings: [] } : this.deps.validateAdd(drawStart, snap, spec.width, spec.purpose, this.settled, via);
    this.set({ preview: { kind: "draw", from: { x: drawStart.x, z: drawStart.z }, to: { x: snap.x, z: snap.z }, width: spec.width, ok: verdict.blockers.length === 0, reason: reasonOf(verdict.blockers), warning: noteOfVerdict(verdict), snap, impact: verdict.impact ?? null, path: verdict.path ?? null, waterfront: spec.purpose === "waterfront" } });
  }

  // ── 点击 ────────────────────────────────────────────────────────────────

  /** 引擎的选取手势：pickedId = 射线最近命中物（会话楼 id 或 decor:…），ground = 射线与地形的交点。 */
  click(click: { pickedId: string | null; ground: Vec2 | null; ray?: RepairRay | null }): void {
    if (!this.state.active) return;
    if (this.state.stranded.length) this.set({ stranded: [] }); // 原址接入路的一键擦除只在搬完那一刻提供
    if (this.state.tool === "node") { this.clickNode(click.ground); return; }
    if (this.state.tool === "site") { this.clickSite(click); return; }
    if (this.state.tool === "draw") { this.clickDraw(click.ground); return; }
    if (this.state.tool === "erase") { this.clickErase(click.ground); return; }
    if (this.state.tool === "restyle") { this.clickRestyle(click.ground); return; }
    if (this.state.tool === "drive") { this.clickDrive(click.ground); return; }
    this.clickBuild(click);
  }

  private clickBuild({ pickedId, ground, ray }: { pickedId: string | null; ground: Vec2 | null; ray?: RepairRay | null }): void {
    if (pickedId !== null) {
      if (this.deps.isSessionBuilding(pickedId)) { this.select(pickedId); return; }
      // 所有建筑都可以移动（用户 2026-10-11）：点到非会话建筑，交给设施工具选中它，接着点空地即可搬家。
      const hit = ray ? this.deps.pickSite(ray) : null;
      if (hit) { this.handOverToSite(hit); return; }
      this.set({ message: { kind: "warn", text: "这里是海滨或基础设施装饰（沙滩、码头、桥），不是建筑，不能移动" } });
      return;
    }
    const buildingId = this.state.buildingId;
    if (!buildingId) {
      // 网格拾取没打中（细长的塔身、射线擦边）：用设施的占地体积再拾一次——它更宽容，地标点得中。
      const hit = ray ? this.deps.pickSite(ray) : null;
      if (hit) { this.handOverToSite(hit); return; }
      this.set({ message: HINT.build });
      return;
    }
    if (!ground) { this.deselect(HINT.build); return; } // 点到天空：取消选中
    const parcel = this.deps.nearestParcel(ground.x, ground.z);
    if (!parcel) { this.set({ message: { kind: "warn", text: "这里没有可落位的地块" } }); return; }
    if (parcel.id === this.deps.parcelOf(buildingId)) { this.set({ message: { kind: "hint", text: "它已经在这个地块上了" } }); return; }
    const result = this.deps.moveBuilding(buildingId, parcel.id);
    if (!result.ok) {
      this.set({ message: { kind: "error", text: failText("不能搬到这里", result) } });
      return;
    }
    // 搬成功：引擎已重建城市，重新选中恢复选中环，并按新位置刷新候选。
    this.select(buildingId, {
      kind: result.warnings.length ? "warn" : "ok",
      text: result.warnings.length ? `已搬过去（${result.warnings.map(warningText).join("；")}）` : "已搬过去",
    });
  }

  private clickDraw(ground: Vec2 | null): void {
    if (!ground) return;
    this.lastGround = ground;
    if (this.state.roadType === "viaduct") {
      const at = this.deps.highwayEndAt(ground.x, ground.z) ?? ground;
      const last = this.state.viaduct[this.state.viaduct.length - 1];
      if (last && Math.hypot(at.x - last.x, at.z - last.z) < 3) { this.finishViaduct(); return; } // 在最后一点上再点一下 = 完成（双击）
      const viaduct = [...this.state.viaduct, at];
      this.set({ viaduct, message: viaduct.length === 1 ? { kind: "hint", text: "起点已落下，接着逐点点击；回车或在最后一点上再点一下完成" } : { kind: "hint", text: `已点 ${viaduct.length} 个点；回车完成，Esc 撤回上一个点` } });
      this.recomputePreview();
      return;
    }
    const snap = this.deps.snap(ground.x, ground.z);
    if (!snap) return;
    if (snap.locked) { this.set({ message: { kind: "error", text: `不能从这里接路：${blockerText("locked-edge")}` } }); return; }
    const start = this.state.drawStart;
    const curve = this.state.drawMode === "curve";
    if (!start) {
      this.set({ drawStart: snap, message: curve ? CURVE_START_HINT : { kind: "hint", text: "起点已落下，移动鼠标预览，再点一下落笔；右键或 Esc 放弃这个起点" } });
      this.recomputePreview();
      return;
    }
    // 再点一下刚落下的起点（连续画时就是上一段的终点）= 结束这条路线，回到「等下一个起点」；不必靠 Esc。
    if (!this.state.drawVia && Math.hypot(snap.x - start.x, snap.z - start.z) < 3) {
      this.set({ drawStart: null, drawVia: null, preview: null, message: DRAW_DONE });
      this.recomputePreview();
      return;
    }
    if (curve && !this.state.drawVia) {
      // 经过点不吸附：它是弧线要穿过的位置，不是路口。
      this.set({ drawVia: { x: ground.x, z: ground.z }, message: { kind: "hint", text: "经过点已定：移动鼠标预览弧线，点终点落笔；Esc 重新选经过点" } });
      this.recomputePreview();
      return;
    }
    const spec = ROAD_SPEC[this.state.roadType as Exclude<RoadType, "viaduct">];
    const result = this.deps.addRoad(start, snap, spec.width, spec.purpose, curve ? this.state.drawVia ?? undefined : undefined);
    if (!result.ok) {
      this.set({ message: { kind: "error", text: failText("不能这样画", result) } });
      return;
    }
    // 画成功：城市已重建（端点落在路段中间时那段路已被拆开）。以终点为新起点接着画；
    // 终点落在已有路口/路面上说明接通了，提示一下，仍可继续。
    const warnings = result.warnings.map(warningText);
    this.set({
      drawStart: { ...snap, kind: "node", locked: false }, // 落笔后终点已是路口（拆开或新建）
      drawVia: null,
      message: { kind: warnings.length ? "warn" : "ok", text: warnings.length ? `已画一段（${warnings.join("；")}），接着点下一个点` : "已画一段，接着点下一个点；右键、再点一下这个终点或 Esc 结束" },
    });
    this.recomputePreview();
  }

  // ── 设施 ────────────────────────────────────────────────────────────────

  /** 移动工具点到非会话建筑：切到设施工具并选中它（两种建筑的搬家规则不同，界面上无缝衔接）。 */
  private handOverToSite(site: SiteInfo): void {
    if (site.locked) { this.set({ message: { kind: "warn", text: `${siteLabel(site)}：${site.locked}` } }); return; }
    this.deps.setSelected(null);
    this.lastGround = null;
    this.set({ tool: "site", buildingId: null, candidates: [], drawStart: null, preview: null });
    this.selectSite(site);
  }

  private clearSite(message: RepairMessage | null): void {
    this.set({ site: null, siteTargets: [], message });
  }

  private selectSite(site: SiteInfo, message?: RepairMessage): void {
    const siteTargets = this.deps.siteTargets(site);
    this.set({
      site, siteTargets, ...(this.state.site?.id === site.id ? {} : { siteTurn: 0 }),
      message: message ?? (site.level === "free"
        ? { kind: "hint", text: `已选中${siteLabel(site)}：点地面任意空地搬过去——靠近路会自动贴路、正门朝路（[ / ] 转向），或点「拆除」；原址的接入路${site.kind === "landmark" ? "或堤道" : ""}会留下` }
        : siteTargets.length
        ? { kind: "hint", text: `已选中${siteLabel(site)}，附近有 ${siteTargets.length} 个可搬去的${site.level === "block" ? "空街区" : "空地块"}（绿色）；点任一处搬过去，或点「拆除」` }
        : { kind: "warn", text: `已选中${siteLabel(site)}，但附近没有可搬去的${site.level === "block" ? "空街区" : "空地块"}；可以拆除` }),
    });    this.recomputePreview();
  }

  private clickSite({ pickedId, ground, ray }: { pickedId: string | null; ground: Vec2 | null; ray?: RepairRay | null }): void {
    const site = this.state.site;
    let hit = ray ? this.deps.pickSite(ray) : null;
    // 已选中一座设施后，这一下是「搬到这里」还是「改选另一座」？拾取体积是个高盒子，从斜上方看会挡住旁边的空地
    // （实测点空地先后改选了观景塔、又选回电视塔自己）。判据：引擎的网格拾取没打中任何东西（pickedId 为空）、
    // 且地面点在被盒子擦到的那座设施占地以外 → 用户点的是地面，按搬家处理。真点在建筑上时网格会命中。
    if (hit && site && ground && pickedId === null && !footprintContains(hit, ground)) hit = null;
    if (hit?.locked) { this.set({ message: { kind: "warn", text: `${siteLabel(hit)}：${hit.locked}` } }); return; }
    if (hit) { this.selectSite(hit); return; }
    // 点到的是不可编辑的东西：会话楼归开发商，致敬地标/市政用地与路网海岸绑定。
    if (pickedId !== null && !(site && ground)) {
      // 点到会话楼：切到移动工具并选中它（所有建筑都可以移动）。
      if (this.deps.isSessionBuilding(pickedId)) {
        this.set({ tool: "build", site: null, siteTargets: [], preview: null });
        this.select(pickedId);
        return;
      }
      this.set({ message: { kind: "warn", text: "这里是海滨或基础设施装饰（沙滩、码头、桥），不是建筑，不能移动" } });
      return;
    }
    if (!site) { this.set({ message: HINT.site }); return; }
    if (!ground) { this.clearSite(HINT.site); return; } // 点到天空：取消选中
    const targetId = this.deps.siteTargetAt(site, ground.x, ground.z, this.state.siteTurn);
    if (!targetId) { this.set({ message: { kind: "warn", text: `这里没有可落位的${site.level === "block" ? "街区" : "地块"}` } }); return; }
    const result = this.deps.moveSite(site, targetId);
    if (!result.ok) {
      this.set({ message: result.blockers?.[0] === "unchanged" ? { kind: "hint", text: "它已经在这里了" } : { kind: "error", text: failText("不能搬到这里", result) } });
      return;
    }
    const moved = (result.siteId ? this.deps.siteById(result.siteId) : null) ?? site;
    const notes = result.warnings.map(warningText);
    const stranded = result.strandedEdges ?? [];
    if (stranded.length) notes.push(`原址留下 ${stranded.length} 段断头接入路，可在面板上一键擦掉`);
    this.selectSite(moved, { kind: result.warnings.includes("no-access-road") ? "warn" : "ok", text: notes.length ? `已把${siteLabel(site)}搬过去（${notes.join("；")}）` : `已把${siteLabel(site)}搬过去` });
    this.set({ stranded });
  }

  /** 拆除选中的设施（面板按钮 / Delete 键）。 */
  removeSelected(): void {
    const { active, tool, site } = this.state;
    if (!active || tool !== "site" || !site) return;
    const result = this.deps.removeSite(site);
    if (!result.ok) { this.set({ message: { kind: "error", text: failText("不能拆除", result) } }); return; }
    this.lastGround = null;
    this.set({ site: null, siteTargets: [], preview: null, message: { kind: "ok", text: `已拆除${siteLabel(site)}（撤销可恢复）` } });
  }

  private clickErase(ground: Vec2 | null): void {
    if (!ground) return;
    this.lastGround = ground;
    if (this.deps.highwayAt(ground.x, ground.z)) {
      const result = this.deps.cutHighway(ground.x, ground.z);
      this.set({ message: result.ok ? { kind: "ok", text: "已切掉一截高架（断口各自落地成匝道）" } : { kind: "error", text: failText("不能切", result) } });
      this.recomputePreview();
      return;
    }
    const edge = this.deps.edgeAt(ground.x, ground.z);
    if (!edge) { this.set({ message: { kind: "warn", text: "这里没有道路可擦" } }); return; }
    const result = this.deps.dropEdge(edge.id);
    if (!result.ok) {
      this.set({ message: { kind: "error", text: failText("不能擦", result) } });
      return;
    }
    const warnings = result.warnings.map(warningText);
    this.set({ message: { kind: warnings.length ? "warn" : "ok", text: warnings.length ? `已擦掉一段路（${warnings.join("；")}）` : "已擦掉一段路" } });
    this.recomputePreview();
  }

  /** 体检条目「修复方案」：给出擦桥 + 重画的候选，地图上预览，等玩家采用。 */
  proposeBridgeFix(deckId: string): void {
    if (!this.state.active) return;
    const result = this.deps.proposeBridgeFix(deckId);
    if (!result.ok) { this.set({ proposal: null, message: { kind: "warn", text: `找不到自动修复方案：${bridgeFixRefusalText(result)}——可以用橡皮擦整座擦掉这座桥，再自己画` } }); return; }
    const { proposal } = result;
    const extra = proposal.erase.length - 1;
    const notes = proposal.warnings.map(warningText).filter(Boolean);
    this.set({ proposal, preview: { kind: "proposal", erase: proposal.erasePolylines, draw: proposal.draw },
      message: { kind: "hint", text: `修复方案：擦掉整座桥${extra ? `和 ${extra} 段岸边残路` : ""}，在绿色处画一座 ${proposal.draw.bridgeLength} 的直桥${notes.length ? `（${notes.join("；")}）` : ""}——点「采用」写入，Esc 放弃` } });
  }

  /** 采用方案：一步写入（一步撤销），接着沿新桥试驾一遍。 */
  acceptProposal(): void {
    const proposal = this.state.proposal;
    if (!this.state.active || !proposal) return;
    const result = this.deps.applyBridgeFix(proposal);
    if (!result.ok) { this.set({ proposal: null, preview: null, message: { kind: "error", text: failText("方案写不进去", result) } }); return; }
    const { from, to } = proposal.draw; const mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
    const deck = this.deps.edgeAt(mid.x, mid.z);
    const report = deck ? this.deps.testDrive(deck.id) : null;
    const drove = report ? `；${driveMessage(report).text}` : "";
    this.set({ proposal: null, preview: report ? { kind: "drive", points: report.path, width: report.width, result: report.verdict, blockedAt: report.blockedAt } : null,
      message: { kind: report && report.verdict !== "passed" ? "warn" : "ok", text: `已按方案重建这座桥（撤销可恢复）${drove}` } });
    if (deck && report) this.driveShown = deck.id;
  }

  private driveShown: string | null = null;
  private clickDrive(ground: Vec2 | null): void {
    if (!ground) return;
    this.lastGround = ground;
    const edge = this.deps.edgeAt(ground.x, ground.z);
    if (!edge) { this.set({ message: { kind: "warn", text: "这里没有道路可试驾" } }); return; }
    const run = () => {
      const report = this.deps.testDrive(edge.id);
      if (!report) { this.set({ message: { kind: "warn", text: "这段路太短，试驾不了——点它连着的长一点的路" } }); return; }
      this.driveShown = edge.id;
      this.set({ preview: { kind: "drive", points: report.path, width: report.width, result: report.verdict, blockedAt: report.blockedAt }, message: driveMessage(report) });
    };
    this.set({ message: { kind: "hint", text: "试驾中…" } });
    // 编译驾驶面要一两秒：先让「试驾中」画出来再跑（测试里没有 defer，同步跑）。
    if (this.deps.defer) this.deps.defer(run, 30); else run();
  }

  private clickRestyle(ground: Vec2 | null): void {
    if (!ground) return;
    this.lastGround = ground;
    if (this.state.roadType === "viaduct") { this.set({ message: { kind: "warn", text: "高架不是地面路的路型：改路请选小路、次干道、主干道或滨海大道" } }); return; }
    const edge = this.deps.edgeAt(ground.x, ground.z);
    if (!edge) { this.set({ message: { kind: "warn", text: "这里没有道路" } }); return; }
    const spec = ROAD_SPEC[this.state.roadType];
    const result = this.deps.restyleRoad(edge.id, spec.width, spec.purpose);
    if (!result.ok) {
      this.set({ message: { kind: "error", text: result.blockers?.includes("unchanged") ? "这条路已经是这个路型了" : failText("不能改", result) } });
      return;
    }
    const warnings = result.warnings.map(warningText);
    const label = ROAD_TYPE_LABEL[this.state.roadType];
    this.set({ message: { kind: warnings.length ? "warn" : "ok", text: warnings.length ? `已改成${label}（${warnings.join("；")}）` : `已改成${label}` } });
    this.recomputePreview();
  }

  /** 自由级设施落位前转向：在自动朝向（正门朝路）之上再转 ±90°。 */
  rotateSite(direction: 1 | -1): void {
    const { active, tool, site } = this.state;
    if (!active || tool !== "site" || !site || site.level !== "free") return;
    this.set({ siteTurn: (this.state.siteTurn + direction + 4) % 4 });
    this.recomputePreview();
  }

  /** 擦掉刚搬走的地标在原址留下的断头接入路（面板按钮）。 */
  eraseStranded(): void {
    const { active, stranded } = this.state;
    if (!active || !stranded.length) return;
    const result = this.deps.dropEdges(stranded);
    this.set({ stranded: [], message: result.ok ? { kind: "ok", text: `已擦掉原址的 ${stranded.length} 段接入路（撤销可恢复）` } : { kind: "error", text: failText("不能擦", result) } });
    this.recomputePreview();
  }

  // ── 路口 ────────────────────────────────────────────────────────────────

  private clickNode(ground: Vec2 | null): void {
    if (!ground) return;
    this.lastGround = ground;
    const node = this.state.dragNode;
    if (!node) {
      const near = this.deps.nodeAt(ground.x, ground.z);
      if (!near) { this.set({ message: { kind: "warn", text: "这里没有路口——把鼠标移到路口上（蓝色圆环）再点" } }); return; }
      if (near.locked) { this.set({ message: { kind: "error", text: `这个路口不能拖：${blockerText("locked-edge")}` } }); return; }
      this.set({ dragNode: near, message: { kind: "hint", text: `已拿起路口（连着 ${near.edges.length} 段路）：移动鼠标预览，再点一下放下；Esc 放回原处` } });
      this.recomputePreview();
      return;
    }
    const result = this.deps.moveNode(node.id, ground.x, ground.z);
    if (!result.ok) {
      if (result.blockers?.[0] === "unchanged") { this.set({ dragNode: null, message: HINT.node }); this.recomputePreview(); return; }
      this.set({ message: { kind: "error", text: failText("不能放在这里", result) } });
      return;
    }
    const warnings = result.warnings.map(warningText);
    this.set({ dragNode: null, message: { kind: warnings.length ? "warn" : "ok", text: warnings.length ? `已移动路口（${warnings.join("；")}）` : "已移动路口" } });
    this.recomputePreview();
  }

  /** 撤销/重做/恢复生成/数据刷新之后：楼/路可能已不在原处，重算选中与预览。 */
  refresh(message?: RepairMessage): void {
    if (!this.state.active) return;
    const { tool, buildingId, site } = this.state;
    if (tool === "site") {
      if (!site) { if (message) this.set({ message }); return; }
      const again = this.deps.siteById(site.id);
      if (!again) { this.clearSite(message ?? { kind: "warn", text: "选中的设施已不在城市里" }); return; }
      this.selectSite(again, message);
      return;
    }
    if (tool === "build") {
      if (!buildingId) { if (message) this.set({ message }); return; }
      if (!this.deps.isSessionBuilding(buildingId)) { this.deselect(message ?? { kind: "warn", text: "选中的楼已不在城市里" }); return; }
      this.select(buildingId, message);
      return;
    }
    // 路网变了：拿在手上的路口可能已不存在（id 随坐标变）——放下；画路起点保留坐标，预览按新路网重算。
    if (tool === "node" && this.state.dragNode) this.set({ dragNode: null });
    if (this.state.stranded.length) this.set({ stranded: [] });
    if (message) this.set({ message });
    this.recomputePreview();
  }
}
