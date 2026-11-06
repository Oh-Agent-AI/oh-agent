/**
 * 跨档重定位（docs/CITY_MAP_EDITOR_ROADMAP_SPEC.md P0-2）。
 *
 * 会话数跨过 400 的倍数，城市升一档：岛按原形状放大、地块与路口全部重排（cityLayout 的跨档迁移同理处理会话楼）。
 * 补丁原先整份报 tier-changed——366 天时间窗下活跃用户每几周就跨一档，等于「改好的地图过几天全没了」。
 *
 * 这里把旧档补丁逐条搬到新档（纯函数）：
 *   - 坐标型（画路端点、高架点、切高架点、自由级搬家目标）：× 缩放比（新岛半径 / 旧岛半径，与生成器的楼迁移同一口径）；
 *   - 引用型（删路段、拖路口、设施拆/搬、移楼）：锚点 × 缩放比后找新档里最近的同类对象（容差内），换成新 id；
 *   - 找不到对应 / 没有锚点 / 新档重放仍失效的：逐条进 failed，不猜（与 stale 同一原则）。
 * 道路日志按顺序处理，每条引用型操作都对「已搬过来的前序操作」套用后的布局解析——后面的操作可能引用前面拆出来的路。
 * 新档的路网是生成器重新长出来的，不是旧路网的精确放大：重定位后的结果与原意可能有出入，这是如实的代价。
 */
import type { CityModel } from "../cityModel";
import type { CityLayout, Vec2 } from "./cityLayout";
import { applyPlanPatch, appendHighwayOp, appendRoadOp, appendTerrainOp, appendSiteOp, edgeLocked, emptyPlanPatch, nearestOnPolyline, pruneStalePatch, quantize, reservedParcelIdsShared, validateBuildingMove, type PatchStaleEntry, type PlanPatchV1 } from "./planPatch";
import { listSites, parseFreeTarget, siteClassOf, siteMoveProblem, type SiteInfo } from "./planSites";

export type RemapFailure = { kind: string; id: string; detail: string };
export type RemapReport = { fromTier: number; toTier: number; ratio: number; total: number; remapped: number; alreadySatisfied: RemapFailure[]; failed: RemapFailure[] };

/** 引用型对象的匹配容差（缩放后的锚点到新档对象）。新档路网是重新生长的，路口位置会漂移十来个单位。 */
const MATCH_RADIUS = 16;
/** 设施更大、重排时漂得更远。 */
const SITE_MATCH_RADIUS = 40;
/** 设施搬家找目标街区/地块的范围：候选按距离排序，附近有合法的就近取；稠密区附近全被邻居的占地盖住时才会取到远处。 */
const SITE_MOVE_TARGET_RADIUS = 120;
/** 按类别拆除时，新档同类设施离原位置的最远距离。 */
const SITE_REMOVE_RADIUS = 80;
/** 移楼：缩放后的目标位置附近找空地块的范围。候选按距离排序，就近优先；会话楼加粗后稠密区的空地块常被邻居的粗占地盖住
 *  （building-overlap），60 时 2000 栋档只有 71% 的编辑能存活（门槛 80%），放到 240 仍是「离用户意图最近的合法空地」。 */
const MOVE_RADIUS = 240;

const parseNode = (id: string): Vec2 | null => {
  const m = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(id);
  return m ? { x: Number(m[1]), z: Number(m[2]) } : null;
};
const parseEdgeMid = (id: string): Vec2 | null => {
  const parts = id.split("/");
  if (parts.length !== 2) return null;
  const a = parseNode(parts[0]); const b = parseNode(parts[1]);
  return a && b ? { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 } : null;
};

/** 缩放比：新岛半径 / 旧岛半径；旧补丁没记半径时按生成器的初值口径 390·√tier 推。 */
export function remapRatio(patch: PlanPatchV1, layout: CityLayout): number {
  if (patch.islandRadius && layout.islandRadius) return layout.islandRadius / patch.islandRadius;
  return Math.sqrt(layout.scaleTier / Math.max(1, patch.scaleTier));
}

/** 把旧档补丁重定位到 layout（新档的**未打补丁**布局）。返回新档补丁（全部失败时为 null）与报告。 */
export function remapPlanPatch(layout: CityLayout, model: CityModel, patch: PlanPatchV1): { patch: PlanPatchV1 | null; report: RemapReport } {
  const ratio = remapRatio(patch, layout);
  const scale = (p: Vec2): Vec2 => quantize({ x: p.x * ratio, z: p.z * ratio });
  const failed: RemapFailure[] = [];
  const alreadySatisfied: RemapFailure[] = [];
  const fail = (kind: string, id: string, detail: string) => failed.push({ kind, id, detail });
  const satisfy = (kind: string, id: string, detail: string) => alreadySatisfied.push({ kind, id, detail });
  let next: PlanPatchV1 = { ...emptyPlanPatch(layout.seed, layout.scaleTier), islandRadius: layout.islandRadius };
  let current: CityLayout | null = layout;
  const view = () => (current ??= applyPlanPatch(layout, next).layout);
  const touched = () => { current = null; };

  // ── 道路日志（按顺序）──
  patch.roadOps.forEach((op, index) => {
    const label = `${index + 1}:${op.t}`;
    if (op.t === "add") {
      next = appendRoadOp(next, { t: "add", from: scale(op.from), to: scale(op.to), width: op.width, ...(op.purpose ? { purpose: op.purpose } : {}), ...(op.via ? { via: scale(op.via) } : {}) }, next.updatedAt); touched();
      return;
    }
    if (op.t === "restyle") {
      // 与 drop 同法找新档里对应的路段；路型是目标状态，原样带过去。
      const anchor = op.anchor ?? parseEdgeMid(op.edge);
      if (!anchor) { fail("road-restyle", label, `路段 ${op.edge} 没有位置信息，无法重定位`); return; }
      const p = scale(anchor);
      let best: { id: string; d: number; mid: Vec2 } | null = null;
      for (const edge of view().roadEdges) {
        if (edgeLocked(edge)) continue;
        const hit = nearestOnPolyline(p, edge.points);
        if (hit.distance <= MATCH_RADIUS && (!best || hit.distance < best.d)) best = { id: edge.id, d: hit.distance, mid: hit.point };
      }
      if (!best) { fail("road-restyle", label, "新档里这附近没有对应的路"); return; }
      next = appendRoadOp(next, { t: "restyle", edge: best.id, width: op.width, ...(op.purpose ? { purpose: op.purpose } : {}), anchor: quantize(best.mid) }, next.updatedAt); touched();
      return;
    }
    if (op.t === "drop") {
      const anchor = op.anchor ?? parseEdgeMid(op.edge);
      if (!anchor) { fail("road-drop", label, `路段 ${op.edge} 没有位置信息，无法重定位`); return; }
      const p = scale(anchor);
      let best: { id: string; d: number; mid: Vec2 } | null = null;
      for (const edge of view().roadEdges) {
        if (edgeLocked(edge)) continue;
        const hit = nearestOnPolyline(p, edge.points);
        if (hit.distance <= MATCH_RADIUS && (!best || hit.distance < best.d)) best = { id: edge.id, d: hit.distance, mid: hit.point };
      }
      // An idempotent delete survives a tier change when the target corridor is already absent:
      // there is nothing left to remove, so do not turn this into a lossy/stale edit.
      if (!best) { satisfy("road-drop", label, "新档目标位置附近已没有对应的路，删除效果已满足"); return; }
      next = appendRoadOp(next, { t: "drop", edge: best.id, anchor: quantize(best.mid) }, next.updatedAt); touched();
      return;
    }
    const anchor = op.anchor ?? parseNode(op.node);
    if (!anchor) { fail("road-move", label, `路口 ${op.node} 没有位置信息，无法重定位`); return; }
    const p = scale(anchor);
    let best: { id: string; d: number; x: number; z: number } | null = null;
    for (const node of view().roadNodes) {
      const d = Math.hypot(node.x - p.x, node.z - p.z);
      if (d <= MATCH_RADIUS && (!best || d < best.d)) best = { id: node.id, d, x: node.x, z: node.z };
    }
    if (!best) { fail("road-move", label, "新档里这附近没有对应的路口"); return; }
    next = appendRoadOp(next, { t: "move", node: best.id, to: scale(op.to), anchor: { x: best.x, z: best.z } }, next.updatedAt); touched();
  });

  // ── 高架日志（全是坐标型）──
  for (const op of patch.highwayOps ?? []) {
    next = op.t === "add" ? appendHighwayOp(next, { t: "add", points: op.points.map(scale) }, next.updatedAt) : appendHighwayOp(next, { t: "cut", at: scale(op.at) }, next.updatedAt);
    touched();
  }

  // ── 平整日志（全是坐标型）：坐标与尺寸按半径比缩放，高度不缩放（海平面不随岛放大）。缩放后越界、
  //    或落水的，交给下面的「新档重放仍失效」如实剔掉——不替玩家猜新位置。──
  for (const op of patch.terrainOps ?? []) {
    const size = (v: number) => Math.round(v * ratio * 100) / 100;
    next = appendTerrainOp(next, op.t === "pad"
      ? { t: "pad", at: scale(op.at), radius: size(op.radius), falloff: size(op.falloff), height: op.height }
      : { t: "ramp", from: { ...scale(op.from), h: op.from.h }, to: { ...scale(op.to), h: op.to.h }, width: size(op.width), falloff: size(op.falloff) }, next.updatedAt);
    touched();
  }

  // ── 设施日志（按顺序；同类设施里找最近的）──
  patch.siteOps.forEach((op, index) => {
    const label = `${index + 1}:${op.t}`;
    const kind = op.t === "remove" ? "site-remove" : "site-move";
    const sites = listSites(view());
    // 致敬地标、市政用地的 id 跨档稳定（landmark:<kind>、public:<id>），先按 id 认；其余按位置。
    let site = op.id.startsWith("landmark:") || op.id.startsWith("public:") ? sites.find((candidate) => candidate.id === op.id) ?? null : null;
    if (!site) {
      if (!op.at) { fail(kind, label, `${op.id} 没有位置信息，无法重定位`); return; }
      const p = scale(op.at);
      // 有类别：同类里找。搬家不限距离（用户的意图是「这种设施放到那儿」，生成器在新档把它摆到别处不改变这个意图）；
      // 拆除限 SITE_REMOVE_RADIUS（拆掉一座已经远在别处的同类设施是猜）。背景楼成百上千、同类太多，始终按近距离。
      // 没有类别（旧补丁）：同 id 前缀、近距离——公共设施 id 是序号，跨档后同号可能是别的种类，只能保守。
      const free = op.cls ? op.t === "move" && !op.cls.startsWith("context/") : false;
      const radius = op.cls && op.t === "remove" && !op.cls.startsWith("context/") ? SITE_REMOVE_RADIUS : SITE_MATCH_RADIUS;
      let best: { site: SiteInfo; d: number } | null = null;
      for (const candidate of sites) {
        if (op.cls ? siteClassOf(candidate) !== op.cls : candidate.id.split(":")[0] !== op.id.split(":")[0]) continue;
        const d = Math.hypot(candidate.x - p.x, candidate.z - p.z);
        if ((free || d <= radius) && (!best || d < best.d)) best = { site: candidate, d };
      }
      site = best?.site ?? null;
    }
    if (!site) { fail(kind, label, `新档里 ${op.id} 附近没有同类设施`); return; }
    if (op.t === "remove") { next = appendSiteOp(next, { t: "remove", id: site.id, at: { x: site.x, z: site.z }, cls: siteClassOf(site) }, next.updatedAt); touched(); return; }
    const free = parseFreeTarget(op.to);
    let to: string | null = null; let toAnchor: Vec2 | undefined;
    if (free) { const q = scale(free); to = `@${q.x},${q.z}${free.yaw === undefined ? "" : `,${free.yaw}`}`; } // 朝向不随缩放变
    else if (op.toAnchor) {
      // 新档里离缩放后目标最近的**合法**街区/地块（与编辑器同一个 siteMoveProblem）。曾只取最近的一个——
      // 新档在那儿长出了别的楼，重放判 target-occupied，真实城市里设施搬家 4/4 全失败（verify-plan-remap (e)）。
      const q = scale(op.toAnchor);
      const layoutNow = view();
      const options = site.level === "block"
        ? layoutNow.blocks.filter((block) => block.parcels.length).map((block) => ({ id: block.id, x: block.x, z: block.z }))
        : layoutNow.blocks.flatMap((block) => block.parcels).map((parcel) => ({ id: parcel.id, x: parcel.x, z: parcel.z }));
      const pick = options
        .map((option) => ({ ...option, d: Math.hypot(option.x - q.x, option.z - q.z) }))
        .filter((option) => option.d <= SITE_MOVE_TARGET_RADIUS)
        .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))
        .find((option) => !siteMoveProblem(layoutNow, site!, option.id, next.suppressedContext));
      if (pick) { to = pick.id; toAnchor = { x: pick.x, z: pick.z }; }
    }
    if (!to) { fail(kind, label, op.toAnchor || free ? "新档里目标位置附近没有空的街区/地块" : `${op.id} 的搬家目标没有位置信息，无法重定位`); return; }
    next = appendSiteOp(next, { t: "move", id: site.id, at: { x: site.x, z: site.z }, to, cls: siteClassOf(site), ...(toAnchor ? { toAnchor } : {}) }, next.updatedAt); touched();
  });

  // ── 移楼：缩放后的目标位置附近，最近的合法空地块（逐栋，后面的楼看得到前面的占用）──
  const present = new Set(model.buildings.map((building) => building.id));
  for (const id of Object.keys(patch.buildingMoves).sort()) {
    const anchor = patch.moveAnchors?.[id];
    if (!present.has(id)) { fail("building-move", id, "会话楼不在当前数据里"); continue; }
    if (!anchor) { fail("building-move", id, "旧补丁没记下目标位置，无法重定位"); continue; }
    const q = scale(anchor);
    const layoutNow = view();
    const taken = reservedParcelIdsShared(layoutNow, next.suppressedContext);
    const claimed = new Set(Object.values(next.buildingMoves));
    const candidates = layoutNow.blocks.flatMap((block) => block.parcels)
      .map((parcel) => ({ parcel, d: Math.hypot(parcel.x - q.x, parcel.z - q.z) }))
      .filter(({ parcel, d }) => d <= MOVE_RADIUS && !taken.has(parcel.id) && !claimed.has(parcel.id))
      .sort((a, b) => a.d - b.d || (a.parcel.id < b.parcel.id ? -1 : 1));
    const target = candidates.find(({ parcel }) => validateBuildingMove(layoutNow, model, next, id, parcel.id).blockers.length === 0)?.parcel;
    if (!target) { fail("building-move", id, "新档里目标位置附近没有空地块"); continue; }
    next = { ...next, buildingMoves: { ...next.buildingMoves, [id]: target.id }, moveAnchors: { ...next.moveAnchors, [id]: { x: target.x, z: target.z } } };
    touched();
  }

  // ── 背景楼压制（M3 遗留）：id 里只有地块 id，没有可靠坐标——如实报失败 ──
  for (const id of patch.suppressedContext) fail("context-suppress", id, "背景楼压制不支持跨档重定位");

  // ── 新档重放仍失效的：剔掉并计入失败 ──
  const replay: PatchStaleEntry[] = applyPlanPatch(layout, next).stale;
  for (const entry of replay) fail(entry.kind, `新档:${entry.id}`, entry.detail);
  const cleaned = replay.length ? pruneStalePatch(next, replay, next.updatedAt) : next;
  const total = patch.roadOps.length + (patch.highwayOps?.length ?? 0) + (patch.terrainOps?.length ?? 0) + patch.siteOps.length + Object.keys(patch.buildingMoves).length + patch.suppressedContext.length;
  const final = cleaned && Object.keys(cleaned.buildingMoves).length + cleaned.roadOps.length + (cleaned.highwayOps?.length ?? 0) + (cleaned.terrainOps?.length ?? 0) + cleaned.siteOps.length + cleaned.suppressedContext.length ? cleaned : null;
  return { patch: final ? { ...final, updatedAt: Date.now() } : null, report: { fromTier: patch.scaleTier, toTier: layout.scaleTier, ratio, total,
    remapped: Math.max(0, total - failed.length - alreadySatisfied.length), alreadySatisfied, failed } };
}
