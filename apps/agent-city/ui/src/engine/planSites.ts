/**
 * 规划修复：非会话建筑（设施）的编辑规则——市长管公共设施，会话楼由开发商（程序）盖，用户不手造会话楼
 * （docs/CITY_PLAN_MANUAL_REPAIR_SPEC.md §14）。
 *
 * 可编辑的四类，都是按街区/地块摆放、不牵连路网与海岸的：
 *   civic（学校/商场/医院，占整个空街区）、garden（城区花园，占整个街区）、
 *   district-landmark（城区地标，占一个地块）、context（背景楼，占一个地块）。
 * 放权后（SPEC §15）还可编辑：致敬地标（landmark）与市政用地（public-site）——拆除、或搬到任意空地（free 级）。
 * 它们的旧接入路会留成断头路（提示，不拒绝）。用户 2026-10-11 拍板「所有建筑都可以被移动」：
 * 海上地标（原址堤道留下）与港口（搬到内陆就失去码头的意义，由用户自己判断）也放开；
 * 唯一锁定的是悬索桥——它不是建筑，是路网里的一段桥面，锁定理由随对象给出，点到时原样显示。
 *
 * 落位判定与生成器**同一个谓词**（注册表 SPEC §5 / 路线图 P1-3，修 D1、D2）：街区级（学校/商场/医院、花园，face-lot）
 * 与城区地标（face-reserve）的搬家调生成器导出的 `checkSitePlacement`——渲染包络在目标街区的**真实面**内、不压路/高架/
 * 其他设施、地形可建。曾用「整块空街区 + 外接矩形」近似：不规则街区里设施出界（D2）、城区地标搬到装不下 17 m 裙房的地方（D1）。
 * 设施搬家保持自身尺寸（不再被拉成街区外接矩形），位置/朝向取谓词接受的候选。
 *
 * 操作带**位置校验**（`at`）：公共设施 id 是按序号编的（civic:0、civic:1…），数据增长后序号会变，
 * 没有校验时旧补丁会悄悄落到另一座设施上；位置对不上就判失效，不猜。
 * 纯函数、无副作用；被 planPatch（重放）与编辑器（校验/拾取/候选）共用。
 */
import { checkSitePlacement, type CivicKind, type CityLayout, type Parcel, type Vec2 } from "./cityLayout";
import { civicEnvelopeSize, DISTRICT_LANDMARK_ENVELOPE } from "./models/layoutPlacementGeometry";
import { clearsHighways } from "./cityPlan";
import { clearanceRoads, edgesNear, parcelIndex, rectClearOfRoads, reservedParcelIds } from "./planGeometry";
import { polygonsOverlap, rectPolygon, ROAD_SETBACK, segmentPolygonDistance, siteFootprint, toWorld, worldBox, worldOverhead, worldParts, yawFacing, type FootprintSpec, type Polygon } from "./planFootprint";
import type { PatchStaleEntry } from "./planPatch";

export type SiteKind = "civic" | "garden" | "district-landmark" | "context" | "landmark" | "public-site";

/** cls：写下时设施的类别（`siteClassOf`，如 "civic/school"）。公共设施的 id 是序号（civic:0），跨档后序号对应的可能已是
 *  另一种设施——重定位按类别找（路线图 SPEC P0-2）。 */
export type SiteOp =
  | { t: "remove"; id: string; at?: Vec2; cls?: string }
  /** toAnchor：目标街区/地块写下时的中心（跨档重定位用，路线图 SPEC P0-2）；自由级目标 "@x,z" 自带坐标，不需要。 */
  | { t: "move"; id: string; at?: Vec2; to: string; toAnchor?: Vec2; cls?: string };

/** 设施的类别签名：种类 + 子类（学校/商场…、地标种类、市政用地种类）。 */
export const siteClassOf = (site: Pick<SiteInfo, "kind" | "civicKind" | "landmarkKind" | "publicKind">): string =>
  `${site.kind}/${site.civicKind ?? site.landmarkKind ?? site.publicKind ?? ""}`;

export type SiteInfo = {
  id: string;
  kind: SiteKind;
  civicKind?: CivicKind;
  landmarkKind?: string;
  publicKind?: string;
  x: number; z: number; yaw: number; width: number; depth: number; height: number; y: number;
  /** block：占整个街区（目标是街区 id）；parcel：占一个地块（目标是地块 id）；free：按模型占地，目标是任意地面点（"@x,z[,yaw]"）。 */
  level: "block" | "parcel" | "free";
  /** free 级：模型原点处的名义预留半径（生成器的 radius）、模型真实占地，以及占地包围盒在世界里的朝向矩形。
   *  x/z 仍是模型原点（位置校验 `at` 认它）；画标记、拾取、碰撞一律用 box（siteBox）。 */
  radius?: number;
  footprint?: FootprintSpec;
  box?: { x: number; z: number; yaw: number; width: number; depth: number };
  /** 非空 = 锁定，内容是给用户看的理由（不能搬、不能拆）。 */
  locked?: string;
  /** 当前所在的街区/地块 id。 */
  slotId: string;
};

/** 设施占地的朝向矩形：free 级用模型占地的包围盒，其余就是它自己的 x/z/width/depth。 */
export const siteBox = (site: Pick<SiteInfo, "x" | "z" | "yaw" | "width" | "depth" | "box">) => site.box ?? { x: site.x, z: site.z, yaw: site.yaw, width: site.width, depth: site.depth };

const footprintCache = new Map<string, FootprintSpec>();
/** free 级设施的模型占地（按 种类|id|半径 缓存：庄园的声明要按 id 种子生成，悬停拾取每帧都要列设施）。 */
export function footprintFor(kind: string, id: string, radius: number, island = false): FootprintSpec {
  const key = `${kind}|${id}|${radius}|${island ? 1 : 0}`;
  let hit = footprintCache.get(key);
  if (!hit) { hit = siteFootprint(kind, id, radius, island); footprintCache.set(key, hit); }
  return hit;
}

export type SiteTarget = { id: string; x: number; z: number; yaw: number; width: number; depth: number; distance: number };

const PICK_HEIGHT = { civic: 28, garden: 12, "district-landmark": 45 } as const;
const SLOPE_LIMIT = 0.55;

export function siteKindOf(id: string): SiteKind | null {
  if (id.startsWith("landmark:")) return "landmark";
  if (id.startsWith("public:")) return "public-site";
  if (id.startsWith("civic:")) return "civic";
  if (id.startsWith("garden:")) return "garden";
  if (id.startsWith("district-landmark:")) return "district-landmark";
  if (id.startsWith("context:")) return "context";
  return null;
}

/** 当前布局里全部可编辑设施。 */
export function listSites(layout: CityLayout): SiteInfo[] {
  const parcels = parcelIndex(layout);
  const out: SiteInfo[] = [];
  for (const civic of layout.civics) {
    out.push({ id: civic.id, kind: "civic", civicKind: civic.kind, x: civic.x, z: civic.z, yaw: civic.yaw, width: civic.width, depth: civic.depth, height: PICK_HEIGHT.civic, y: civic.y, level: "block", slotId: civic.parcelId });
  }
  for (const garden of layout.gardens) {
    out.push({ id: garden.id, kind: "garden", x: garden.x, z: garden.z, yaw: garden.yaw, width: garden.width, depth: garden.depth, height: PICK_HEIGHT.garden, y: garden.y, level: "block", slotId: garden.blockId });
  }
  for (const landmark of layout.districtLandmarks ?? []) {
    const parcel = parcels.get(landmark.parcelId);
    out.push({ id: `district-landmark:${landmark.districtId}`, kind: "district-landmark", x: landmark.x, z: landmark.z, yaw: landmark.yaw, width: parcel?.width ?? 8, depth: parcel?.depth ?? 8, height: PICK_HEIGHT["district-landmark"], y: landmark.y, level: "parcel", slotId: landmark.parcelId });
  }
  for (const context of layout.contextBuildings) {
    out.push({ id: context.id, kind: "context", x: context.x, z: context.z, yaw: context.yaw, width: context.width, depth: context.depth, height: context.height, y: context.y, level: "parcel", slotId: context.id.replace(/^context:/, "") });
  }
  const ground = (x: number, z: number) => Math.max(0, layout.terrain.height(x, z));
  for (const landmark of layout.landmarks ?? []) {
    if (!landmark.radius) continue;
    const locked = landmark.kind === "suspension-bridge" ? "悬索桥不是建筑，是路网里的一段桥面（由桥梁模型绑定），不能单独搬或拆——要拆就用橡皮擦整座擦掉这座桥" : undefined;
    const footprint = footprintFor(landmark.kind, landmark.id, landmark.radius, !!landmark.shore);
    const box = worldBox(footprint, landmark, landmark.yaw);
    out.push({ id: landmark.id, kind: "landmark", landmarkKind: landmark.kind, x: landmark.x, z: landmark.z, yaw: landmark.yaw, width: box.width, depth: box.depth, height: Math.max(30, landmark.radius * 2.5), y: ground(landmark.x, landmark.z), level: "free", slotId: "", radius: landmark.radius, footprint, box, ...(locked ? { locked } : {}) });
  }
  for (const site of layout.publicSites ?? []) {
    if (!site.radius) continue;
    const footprint = footprintFor(site.kind, `public:${site.id}`, site.radius);
    const box = worldBox(footprint, site, site.yaw);
    out.push({ id: `public:${site.id}`, kind: "public-site", publicKind: site.kind, x: site.x, z: site.z, yaw: site.yaw, width: box.width, depth: box.depth, height: 22, y: ground(site.x, site.z), level: "free", slotId: "", radius: site.radius, footprint, box });
  }
  return out;
}

/** 目标街区/地块能否接收这座设施；null = 可以，否则返回阻止原因码。 */
export function siteMoveProblem(layout: CityLayout, site: SiteInfo, targetId: string, suppressedContext: Iterable<string> = []): string | null {
  if (site.locked) return "site-locked";
  if (site.level === "free") return freeMoveProblem(layout, site, targetId);
  if (targetId === site.slotId) return "unchanged";
  const reserved = reservedParcelIds(layout, suppressedContext);
  if (site.level === "block") {
    const block = layout.blocks.find((candidate) => candidate.id === targetId);
    if (!block || !block.parcels.length) return "missing-target";
    if (block.parcels.some((parcel) => reserved.has(parcel.id))) return "target-occupied";
    const placed = blockPlacement(layout, site, targetId, suppressedContext);
    return placed.ok ? null : placed.problem;
  }
  const parcel = parcelIndex(layout).get(targetId);
  if (!parcel) return "missing-target";
  if (site.kind === "district-landmark") {
    // 城区地标的 17 m 裙房占整面（与生成器一致，注册表 SPEC D1）：目标所在街区除它自己外必须全空。
    const without = { ...layout, districtLandmarks: (layout.districtLandmarks ?? []).filter((landmark) => `district-landmark:${landmark.districtId}` !== site.id) };
    const free = reservedParcelIds(without, suppressedContext);
    const block = layout.blocks.find((candidate) => candidate.id === parcel.blockId);
    if ((block?.parcels ?? [parcel]).some((member) => free.has(member.id))) return "target-occupied";
    // 17 m 裙房 ⊕ 地址：与生成器摆城区地标时同一个包络检查（修 D1：地址够、裙房装不下的街区）。
    const placed = placementVerdict(layout, site, { ...parcel, ...DISTRICT_LANDMARK_ENVELOPE, blockId: parcel.blockId }, suppressedContext);
    if (placed) return placed;
  } else if (reserved.has(parcel.id)) return "target-occupied";
  if (!layout.terrain.buildable(parcel.x, parcel.z)) return "not-buildable";
  if (layout.terrain.slope(parcel.x, parcel.z) > SLOPE_LIMIT) return "steep-slope";
  if (!clearsHighways(parcel, 16, 16, layout.highways)) return "highway-clearance";
  if (!rectClearOfRoads(layout, parcel, 0.5)) return "site-over-road";
  return null;
}

/** 生成器谓词的拒绝原因 → 编辑器的问题码（面板按码翻译成人话）。 */
function placementProblem(reason: string | undefined): string {
  if (reason === "actual-road-capsule-conflict") return "site-over-road";
  if (reason === "highway-capsule-conflict") return "highway-clearance";
  if (reason === "declared-site-circle-conflict") return "target-occupied";
  if (reason === "rectangle-terrain-or-reserve-conflict") return "not-buildable";
  return "does-not-fit"; // 越出街区真实面、压到洞（水塘/广场），或几何无效
}

/** 搬家时的占用：别的设施与会话楼占的地块（不含正在搬的这座自己——生成器同口径：occupancy excludes the moving owner）。 */
function occupiedWithout(layout: CityLayout, site: SiteInfo, suppressedContext: Iterable<string>): Parcel[] {
  const without: CityLayout = {
    ...layout,
    civics: layout.civics.filter((civic) => civic.id !== site.id),
    gardens: layout.gardens.filter((garden) => garden.id !== site.id),
    districtLandmarks: (layout.districtLandmarks ?? []).filter((landmark) => `district-landmark:${landmark.districtId}` !== site.id),
  };
  const reserved = reservedParcelIds(without, suppressedContext);
  return [...parcelIndex(layout).values()].filter((parcel) => reserved.has(parcel.id));
}

/** 一次生成器谓词检查；null = 接受。 */
function placementVerdict(layout: CityLayout, site: SiteInfo, footprint: Vec2 & { yaw: number; width: number; depth: number; blockId: string }, suppressedContext: Iterable<string>): string | null {
  const result = checkSitePlacement(layout, footprint, occupiedWithout(layout, site, suppressedContext));
  return result.ok ? null : placementProblem(result.reason);
}

/** 设施的渲染包络尺寸（谓词检查用）：商场/学校/医院按 civicEnvelopeSize（窗台、雨棚、旗杆外伸），花园就是自身矩形。 */
function envelopeOf(site: SiteInfo): { width: number; depth: number } {
  return (site.civicKind && civicEnvelopeSize(site.civicKind, site.width, site.depth)) || { width: site.width, depth: site.depth };
}

export type BlockPlacement = { ok: true; x: number; z: number; yaw: number } | { ok: false; problem: string };
const blockPlacementMemo = new WeakMap<CityLayout, Map<string, BlockPlacement>>();
/**
 * 街区级设施（face-lot）搬进一个空街区：保持自身尺寸，按确定的顺序试候选落点——街区中心、地块重心、各地块中心；
 * 朝向先取地块朝向、再转 90°——第一个被生成器谓词接受的就是落点。全部被拒返回第一个拒绝原因（最有代表性的：中心落点为什么不行）。
 * 按（布局, 设施, 街区）记忆：候选列表与套用各要一次。
 */
export function blockPlacement(layout: CityLayout, site: SiteInfo, blockId: string, suppressedContext: Iterable<string> = []): BlockPlacement {
  const suppressed = [...suppressedContext];
  const key = `${site.id}|${blockId}|${site.width}x${site.depth}|${suppressed.join(",")}`;
  let memo = blockPlacementMemo.get(layout);
  const hit = memo?.get(key); if (hit) return hit;
  const block = layout.blocks.find((candidate) => candidate.id === blockId);
  let result: BlockPlacement = { ok: false, problem: "missing-target" };
  if (block?.parcels.length) {
    const envelope = envelopeOf(site);
    const mean = { x: block.parcels.reduce((sum, parcel) => sum + parcel.x, 0) / block.parcels.length, z: block.parcels.reduce((sum, parcel) => sum + parcel.z, 0) / block.parcels.length };
    const centres = [{ x: block.x, z: block.z }, mean, ...block.parcels.slice(0, 8)];
    const yaw = block.parcels[0].yaw;
    let first: string | null = null;
    search: for (const centre of centres) for (const turn of [0, Math.PI / 2]) {
      const problem = placementVerdict(layout, site, { x: centre.x, z: centre.z, yaw: yaw + turn, ...envelope, blockId }, suppressed);
      if (!problem) { result = { ok: true, x: centre.x, z: centre.z, yaw: yaw + turn }; break search; }
      first ??= problem;
    }
    if (!result.ok && first) result = { ok: false, problem: first };
  }
  if (!memo) { memo = new Map(); blockPlacementMemo.set(layout, memo); }
  memo.set(key, result);
  return result;
}

/** "@x,z" 或 "@x,z,yaw" → 坐标（与朝向）；格式不对返回 null。没有 yaw 的旧目标保持原朝向。 */
export function parseFreeTarget(targetId: string): (Vec2 & { yaw?: number }) | null {
  const m = /^@(-?[\d.]+),(-?[\d.]+)(?:,(-?[\d.]+))?$/.exec(targetId);
  return m ? { x: Number(m[1]), z: Number(m[2]), ...(m[3] !== undefined ? { yaw: Number(m[3]) } : {}) } : null;
}
export const formatFreeTarget = (p: Vec2 & { yaw?: number }): string =>
  `@${Math.round(p.x * 100) / 100},${Math.round(p.z * 100) / 100}${p.yaw === undefined ? "" : `,${Math.round(p.yaw * 1e4) / 1e4}`}`;

/** free 级设施在 (origin, yaw) 处的世界**俯视投影**（凸多边形并集；碰撞按它，见 planFootprint 两层投影）。 */
export function freeSiteParts(site: SiteInfo, origin: Vec2, yaw: number): Polygon[] {
  const footprint = site.footprint ?? footprintFor(site.landmarkKind ?? site.publicKind ?? "", site.id, site.radius ?? site.width / 2);
  return worldOverhead(footprint, origin, yaw);
}

/** 别的设施的世界占地：free 级按模型俯视投影，其余按自己的矩形。 */
const sitePolygons = (site: SiteInfo): Polygon[] => (site.level === "free" ? freeSiteParts(site, site, site.yaw) : [rectPolygon(siteBox(site))]);

/**
 * free 级落点建议（像 SimCity 一样「贴路」）：点击处附近有路，就把设施转到正面朝路、平移到前沿离路肩 ROAD_SETBACK；
 * 离路太远（超过设施半径 + 10）只转向不平移。turn：用户额外转的 90° 次数（[ / ] 键）。
 */
export function autoPlaceFree(layout: CityLayout, site: SiteInfo, click: Vec2, turn = 0): Vec2 & { yaw: number } {
  const footprint = site.footprint ?? footprintFor(site.landmarkKind ?? site.publicKind ?? "", site.id, site.radius ?? site.width / 2);
  const extent = Math.hypot(Math.max(Math.abs(footprint.min.x), Math.abs(footprint.max.x)), Math.max(Math.abs(footprint.min.z), Math.abs(footprint.max.z)));
  let best: { p: Vec2; d: number; width: number } | null = null;
  for (const edge of edgesNear(layout, click.x, click.z, extent * 1.5 + 30)) {
    for (let i = 1; i < edge.points.length; i += 1) {
      const p = nearestOnSegment(click, edge.points[i - 1], edge.points[i]);
      const d = Math.hypot(p.x - click.x, p.z - click.z);
      if (!best || d < best.d) best = { p, d, width: edge.width };
    }
  }
  const extra = (turn % 4) * (Math.PI / 2);
  if (!best || best.d < 1e-6) return { ...click, yaw: site.yaw + extra };
  const n = { x: (best.p.x - click.x) / best.d, z: (best.p.z - click.z) / best.d };
  const yaw = yawFacing(n) + extra;
  // 转完以后朝路方向的前沿伸出多少（转了 90° 就是侧面）。
  const front = Math.max(...footprint.overhead.flat().map((v) => { const w = toWorld(v, { x: 0, z: 0 }, yaw); return w.x * n.x + w.z * n.z; }));
  const snapped = { x: best.p.x - n.x * (front + best.width / 2 + ROAD_SETBACK), z: best.p.z - n.z * (front + best.width / 2 + ROAD_SETBACK) };
  const near = Math.hypot(snapped.x - click.x, snapped.z - click.z) <= extent + 10;
  const at = near ? snapped : click;
  return { x: Math.round(at.x * 100) / 100, z: Math.round(at.z * 100) / 100, yaw: Math.round(normalizeAngle(yaw) * 1e4) / 1e4 };
}
const normalizeAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const nearestOnSegment = (p: Vec2, a: Vec2, b: Vec2): Vec2 => {
  const dx = b.x - a.x; const dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return { x: a.x + dx * t, z: a.z + dz * t };
};

/**
 * free 级设施搬到任意地面点（可带朝向）：按**模型真实占地**检查——占地内可建、不压地面路（离路肩至少 1）、不压别的楼与设施。
 * 曾用生成器的名义预留圆：路必须离中心 ≥ 0.75r，矩形建筑永远贴不上路（用户截图：车站接不上路网）。
 * 只认得出预留圆的模型（塔、摩天轮…）照旧按圆，口径与旧版相同。
 */
function freeMoveProblem(layout: CityLayout, site: SiteInfo, targetId: string): string | null {
  const at = parseFreeTarget(targetId);
  if (!at) return "missing-target";
  const yaw = at.yaw ?? site.yaw;
  if (Math.hypot(at.x - site.x, at.z - site.z) < 1 && Math.abs(normalizeAngle(yaw - site.yaw)) < 1e-3) return "unchanged";
  const footprint = site.footprint ?? footprintFor(site.landmarkKind ?? site.publicKind ?? "", site.id, site.radius ?? site.width / 2);
  if (footprint.exact) {
    // 地形看落地的实体（墩、腿、基座）；路与楼的碰撞看俯视投影（悬挑、转盘下面不能有路或楼）。
    const parts = worldOverhead(footprint, at, yaw);
    const samples = [at, ...worldParts(footprint, at, yaw).flat()];
    if (samples.some((p) => !layout.terrain.buildable(p.x, p.z))) return "not-buildable";
    const reach = Math.hypot(footprint.max.x - footprint.min.x, footprint.max.z - footprint.min.z) + 12;
    for (const edge of edgesNear(layout, at.x, at.z, reach)) {
      for (let i = 1; i < edge.points.length; i += 1) {
        if (parts.some((part) => segmentPolygonDistance(edge.points[i - 1], edge.points[i], part) < edge.width / 2 + 1)) return "site-over-road";
      }
    }
    for (const district of layout.districts) for (const slot of district.slots.values()) {
      const lot = rectPolygon({ x: slot.x, z: slot.z, yaw: slot.yaw, width: slot.width * 0.92, depth: slot.depth * 0.9 });
      if (parts.some((part) => polygonsOverlap(part, lot))) return "target-occupied";
    }
    for (const other of listSites(layout)) {
      if (other.id === site.id) continue;
      const others = sitePolygons(other);
      if (parts.some((part) => others.some((poly) => polygonsOverlap(part, poly)))) return "target-occupied";
    }
    return null;
  }
  const r = site.radius ?? site.width / 2;
  const samples = [at, ...Array.from({ length: 8 }, (_, i) => ({ x: at.x + Math.cos((i * Math.PI) / 4) * r * 0.8, z: at.z + Math.sin((i * Math.PI) / 4) * r * 0.8 }))];
  if (samples.some((p) => !layout.terrain.buildable(p.x, p.z))) return "not-buildable";
  for (const edge of clearanceRoads(layout)) {
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1]; const b = edge.points[i];
      const dx = b.x - a.x; const dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.z - a.z) * dz) / l2));
      if (Math.hypot(at.x - a.x - dx * t, at.z - a.z - dz * t) < r * 0.75 + edge.width / 2) return "site-over-road";
    }
  }
  // 圆 × 朝向矩形：把圆心转进矩形局部坐标，夹到矩形内，距离 < r 即相交。
  const hitsRect = (rect: { x: number; z: number; yaw: number; width: number; depth: number }) => {
    const dx = at.x - rect.x; const dz = at.z - rect.z;
    const lx = dx * Math.cos(rect.yaw) - dz * Math.sin(rect.yaw); const lz = dx * Math.sin(rect.yaw) + dz * Math.cos(rect.yaw);
    const cx = Math.max(-rect.width / 2, Math.min(rect.width / 2, lx)); const cz = Math.max(-rect.depth / 2, Math.min(rect.depth / 2, lz));
    return Math.hypot(lx - cx, lz - cz) < r;
  };
  for (const district of layout.districts) for (const slot of district.slots.values()) if (hitsRect({ ...slot, width: slot.width * 0.92, depth: slot.depth * 0.9 })) return "target-occupied";
  for (const other of listSites(layout)) if (other.id !== site.id && hitsRect(siteBox(other))) return "target-occupied";
  return null;
}

/** 离该设施最近的、可以搬过去的空街区/空地块（按距离从近到远逐个校验，凑够 limit 个就停）。 */
export function siteTargets(layout: CityLayout, site: SiteInfo, suppressedContext: Iterable<string> = [], limit = 40, maxDistance = 240): SiteTarget[] {
  if (site.level === "free" || site.locked) return []; // free 级：点任意地面点，不预先列候选
  const candidates: SiteTarget[] = site.level === "block"
    ? layout.blocks.filter((block) => block.parcels.length > 0).map((block) => ({ id: block.id, x: block.x, z: block.z, yaw: block.parcels[0].yaw, width: block.width, depth: block.depth, distance: 0 }))
    : layout.blocks.flatMap((block) => block.parcels).map((parcel) => ({ id: parcel.id, x: parcel.x, z: parcel.z, yaw: parcel.yaw, width: parcel.width, depth: parcel.depth, distance: 0 }));
  const sorted = candidates
    .map((target) => ({ ...target, distance: Math.hypot(target.x - site.x, target.z - site.z) }))
    .filter((target) => target.id !== site.slotId && target.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
  const out: SiteTarget[] = [];
  for (const target of sorted) {
    if (siteMoveProblem(layout, site, target.id, suppressedContext) !== null) continue;
    // 街区级：绿框画设施真实会落的位置与朝向（谓词接受的候选），不是整块街区。
    const placed = site.level === "block" ? blockPlacement(layout, site, target.id, suppressedContext) : null;
    const shown = placed?.ok ? { x: placed.x, z: placed.z, yaw: placed.yaw, width: site.width, depth: site.depth } : {};
    out.push({ ...target, ...shown, distance: Math.round(target.distance) });
    if (out.length >= limit) break;
  }
  return out;
}

/** 射线对设施占地盒（朝向矩形的外接 AABB，外扩 1）求交，取最近的一座。 */
export function pickSite(layout: CityLayout, ray: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }): SiteInfo | null {
  let best: { site: SiteInfo; t: number } | null = null;
  for (const site of listSites(layout)) {
    const box = siteBox(site);
    const ax = Math.cos(box.yaw); const az = -Math.sin(box.yaw); // 局部 x 轴（面宽）
    const bx = Math.sin(box.yaw); const bz = Math.cos(box.yaw);  // 局部 z 轴（进深）
    const hx = Math.abs(ax) * box.width / 2 + Math.abs(bx) * box.depth / 2 + 1;
    const hz = Math.abs(az) * box.width / 2 + Math.abs(bz) * box.depth / 2 + 1;
    const lo = [box.x - hx, site.y, box.z - hz]; const hi = [box.x + hx, site.y + site.height, box.z + hz];
    const o = [ray.origin.x, ray.origin.y, ray.origin.z]; const d = [ray.direction.x, ray.direction.y, ray.direction.z];
    let tMin = 0; let tMax = Infinity; let hit = true;
    for (let axis = 0; axis < 3; axis += 1) {
      if (Math.abs(d[axis]) < 1e-9) { if (o[axis] < lo[axis] || o[axis] > hi[axis]) { hit = false; break; } continue; }
      let t1 = (lo[axis] - o[axis]) / d[axis]; let t2 = (hi[axis] - o[axis]) / d[axis];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1); tMax = Math.min(tMax, t2);
      if (tMin > tMax) { hit = false; break; }
    }
    if (hit && (!best || tMin < best.t)) best = { site, t: tMin };
  }
  return best?.site ?? null;
}

type Arrays = Pick<CityLayout, "civics" | "gardens" | "districtLandmarks" | "contextBuildings" | "landmarks" | "publicSites">;

/**
 * 重放设施操作日志（删/移，按顺序）：先于会话楼移动套用，后者看到的是设施改动后的占用。
 * 每个操作失败就进 stale、不影响后续（同 roadOps）。返回改动后的四组数组。
 */
export function applySiteOps(layout: CityLayout, ops: readonly SiteOp[], suppressedContext: Iterable<string>, stale: PatchStaleEntry[]): Arrays {
  let view: CityLayout = { ...layout, civics: [...layout.civics], gardens: [...layout.gardens], districtLandmarks: [...(layout.districtLandmarks ?? [])], contextBuildings: [...layout.contextBuildings], landmarks: [...(layout.landmarks ?? [])], publicSites: [...(layout.publicSites ?? [])] };
  const suppressed = [...suppressedContext];
  ops.forEach((op, index) => {
    const label = `${index + 1}:${op.t}`;
    const kind = op.t === "remove" ? "site-remove" : "site-move";
    const site = listSites(view).find((candidate) => candidate.id === op.id);
    if (!site) { stale.push({ kind, id: label, reason: "unknown-site", detail: `${op.id} 不在当前城市里（规划已重算或前序操作已改动）` }); return; }
    if (op.at && Math.hypot(site.x - op.at.x, site.z - op.at.z) > 1) { stale.push({ kind, id: label, reason: "site-changed", detail: `${op.id} 的位置已经变了（城市扩容或配套重排），为免落到另一座设施上，这条编辑作废` }); return; }
    if (site.locked) { stale.push({ kind, id: label, reason: "site-blocked", detail: `${op.id} 已锁定：${site.locked}` }); return; }
    if (op.t === "remove") {
      view = {
        ...view,
        civics: view.civics.filter((civic) => civic.id !== op.id),
        gardens: view.gardens.filter((garden) => garden.id !== op.id),
        districtLandmarks: (view.districtLandmarks ?? []).filter((landmark) => `district-landmark:${landmark.districtId}` !== op.id),
        contextBuildings: view.contextBuildings.filter((context) => context.id !== op.id),
        landmarks: (view.landmarks ?? []).filter((landmark) => landmark.id !== op.id),
        publicSites: (view.publicSites ?? []).filter((public_) => `public:${public_.id}` !== op.id),
      };
      return;
    }
    const problem = siteMoveProblem(view, site, op.to, suppressed);
    if (problem === "unchanged") return;
    if (problem) { stale.push({ kind, id: label, reason: problem === "missing-target" ? "missing-target" : problem === "target-occupied" ? "target-occupied" : "site-blocked", detail: `${op.id} → ${op.to}：${problem}` }); return; }
    const height = (x: number, z: number) => layout.terrain.height(x, z);
    if (site.level === "free") {
      // 自由级设施：挪原点，目标带朝向时一起转（旧目标没有朝向，保持原样）；旧接入路留在原地，不替用户删路。
      const at = parseFreeTarget(op.to)!;
      const turn = at.yaw === undefined ? {} : { yaw: at.yaw };
      view = {
        ...view,
        landmarks: (view.landmarks ?? []).map((landmark) => (landmark.id === op.id ? { ...landmark, x: at.x, z: at.z, ...turn } : landmark)),
        publicSites: (view.publicSites ?? []).map((public_) => (`public:${public_.id}` === op.id ? { ...public_, x: at.x, z: at.z, ...turn } : public_)),
      };
      return;
    }
    if (site.level === "block") {
      // 落点 = 生成器谓词接受的候选；尺寸保持设施自己的（曾拉成街区外接矩形：不规则街区里出界，D2）。
      const placed = blockPlacement(view, site, op.to, suppressed);
      if (!placed.ok) return; // siteMoveProblem 刚判过可以，不会走到
      const place = { x: placed.x, z: placed.z, y: height(placed.x, placed.z), yaw: placed.yaw };
      view = {
        ...view,
        civics: view.civics.map((civic) => (civic.id === op.id ? { ...civic, ...place, parcelId: op.to } : civic)),
        gardens: view.gardens.map((garden) => (garden.id === op.id ? { ...garden, ...place, blockId: op.to } : garden)),
      };
    } else {
      const parcel = parcelIndex(view).get(op.to)!;
      const place = { x: parcel.x, z: parcel.z, y: height(parcel.x, parcel.z), yaw: parcel.yaw };
      view = {
        ...view,
        districtLandmarks: (view.districtLandmarks ?? []).map((landmark) => (`district-landmark:${landmark.districtId}` === op.id ? { ...landmark, ...place, parcelId: parcel.id } : landmark)),
        // 背景楼的 id 由地块决定（context:<parcelId>）：搬家后 id 跟着变，占用判定才认得新地块。
        contextBuildings: view.contextBuildings.map((context) => (context.id === op.id ? { ...context, ...place, id: `context:${parcel.id}` } : context)),
      };
    }
  });
  return { civics: view.civics, gardens: view.gardens, districtLandmarks: view.districtLandmarks, contextBuildings: view.contextBuildings, landmarks: view.landmarks, publicSites: view.publicSites };
}
