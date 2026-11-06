/**
 * 推平与安置（docs/CITY_PLAN_MANUAL_REPAIR_SPEC.md §15，参考 SimCity 的推土机）。
 *
 * 放权前，新路/拖动路口只要压到建筑就整笔拒绝——用户实测「处处碰壁」。现在改成：
 *   - 压到的**非会话设施**（公共设施、花园、城区地标、背景楼、可编辑的致敬地标/市政用地）随这一笔一起拆除；
 *   - 压到的**会话楼**不能拆（一栋楼 = 一个真实会话，数据诚实），由「开发商」就近找一块合法空地块安置
 *     （写进 buildingMoves，引擎重建时经 layoutCity 的 pins 在落位阶段生效）；
 *   - 生成器原本就压着的（残余）不算到这一笔头上，不会被顺手拆掉。
 * 纯函数：输入底层布局 + 编辑前的生效布局 + 已追加了道路操作的补丁，输出补上拆除/安置后的补丁与清单。
 */
import type { CityModel } from "../cityModel";
import type { CityLayout, RoadEdge } from "./cityLayout";
import { applyPlanPatch, appendSiteOp, buildingRect, clearanceRoads, nearestOnPolyline, rectClearOfEdges, reservedParcelIdsShared, validateBuildingMove, type PlanPatchV1 } from "./planPatch";
import { roadImpact, viaductEdges } from "./planRoadRules";
import { listSites, siteBox, siteClassOf } from "./planSites";

export type BulldozeResult = {
  patch: PlanPatchV1;
  /** 被推平的设施 id。 */
  bulldozed: string[];
  /** 被开发商安置的会话楼：id → 新地块。 */
  relocated: Array<{ id: string; to: string }>;
  /** 附近找不到合法空地块、只能留在路上的会话楼（如实上报，不硬塞）。 */
  homeless: string[];
};

const COVER_EPS = 0.05;
const SEARCH_RADIUS = 260;

/** 编辑后新出现的路面几何：不在编辑前任一路段上的路段（被拆成两半的旧路不算新几何）。 */
export function freshRoadGeometry(before: CityLayout, after: CityLayout): RoadEdge[] {
  const ids = new Set(before.roadEdges.map((edge) => edge.id));
  // 改路型加宽的路段（同 id、变宽）：路带扫过的新地面也要推平/安置（路线图 P1-4）。
  const widthOf = new Map(before.roadEdges.map((edge) => [edge.id, edge.width]));
  const widened = after.roadEdges.filter((edge) => !edge.bridge && ids.has(edge.id) && edge.width > (widthOf.get(edge.id) ?? Infinity));
  const old = before.roadEdges.filter((edge) => !edge.bridge);
  const covered = (edge: RoadEdge) => {
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1]; const b = edge.points[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      for (let d = 0; d <= len; d += Math.max(1, len / 8)) {
        const t = len ? d / len : 0;
        const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
        if (!old.some((o) => nearestOnPolyline(p, o.points).distance <= COVER_EPS)) return false;
      }
    }
    return true;
  };
  return [...after.roadEdges.filter((edge) => !edge.bridge && !ids.has(edge.id) && !covered(edge)), ...widened];
}

/** 编辑后新出现的高架段（不在编辑前任一高架上），按桥面净空当「路段」用（SPEC §17.2：高架下不能有楼）。 */
export function freshViaductGeometry(before: CityLayout, after: CityLayout): RoadEdge[] {
  const old = before.highways ?? [];
  if (after.highways === before.highways) return [];
  const onOld = (p: { x: number; z: number }) => old.some((run) => run.length >= 2 && nearestOnPolyline(p, run).distance <= 0.5);
  return (after.highways ?? []).flatMap((run) => viaductEdges(run).filter((edge) => {
    const [a, b] = edge.points;
    return !(onOld(a) && onOld(b) && onOld({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }));
  }));
}

/** A session/site already under a viaduct is exempt only from the same pre-existing deck, never from ground-road residue. */
function alreadyUnderViaduct(before: CityLayout, rect: { x: number; z: number; yaw: number; width: number; depth: number }): boolean {
  const decks = (before.highways ?? []).flatMap((run) => viaductEdges(run));
  const near = decks.filter((edge) => edge.points.some((p) => Math.hypot(p.x - rect.x, p.z - rect.z) < 80)
    || nearestOnPolyline(rect, edge.points).distance < 60);
  return !rectClearOfEdges(rect, near, 0.5);
}

/** 编辑前就被地面路压着的矩形（生成器残余）：不该被这一笔顺手拆掉或搬走。 */
function alreadyHit(before: CityLayout, rect: { x: number; z: number; yaw: number; width: number; depth: number }): boolean {
  const near = clearanceRoads(before).filter((edge) => edge.points.some((p) => Math.hypot(p.x - rect.x, p.z - rect.z) < 80) || nearestOnPolyline(rect, edge.points).distance < 60);
  return !rectClearOfEdges(rect, near, 0.5);
}

export function bulldozeForRoads(generated: CityLayout, model: CityModel, before: CityLayout, patch: PlanPatchV1): BulldozeResult {
  let next = patch;
  let after = applyPlanPatch(generated, next).layout;
  const newRoads = freshRoadGeometry(before, after);
  const newViaducts = freshViaductGeometry(before, after);
  const fresh = [...newRoads, ...newViaducts];
  const result: BulldozeResult = { patch: next, bulldozed: [], relocated: [], homeless: [] };
  if (!fresh.length) return result;
  const impact = roadImpact(after, model, fresh);
  const viaductOnlyImpact = roadImpact(after, model, newViaducts);
  const viaductImpact = new Set([...viaductOnlyImpact.bulldoze, ...viaductOnlyImpact.relocate, ...viaductOnlyImpact.locked]);
  const alreadyImpacted = (id: string, rect: { x: number; z: number; yaw: number; width: number; depth: number }) =>
    viaductImpact.has(id) ? alreadyUnderViaduct(before, rect) : alreadyHit(before, rect);

  // 1. 推平设施（锁定设施在校验阶段已拒绝，这里不会出现；万一出现也只是留着）。
  const sites = new Map(listSites(before).map((site) => [site.id, site]));
  for (const id of impact.bulldoze) {
    const site = sites.get(id);
    if (!site || site.locked || alreadyImpacted(id, siteBox(site))) continue;
    next = appendSiteOp(next, { t: "remove", id, at: { x: site.x, z: site.z }, cls: siteClassOf(site) });
    result.bulldozed.push(id);
  }
  if (result.bulldozed.length) after = applyPlanPatch(generated, next).layout;

  // 2. 安置会话楼：逐栋就近找合法空地块，每安置一栋就重算占用，后面的楼不会抢同一块地。
  const buildings = new Map(model.buildings.map((building) => [building.id, building]));
  for (const id of impact.relocate) {
    const building = buildings.get(id);
    const home = before.districts.flatMap((district) => [...district.slots]).find(([key]) => key === id)?.[1];
    if (!building || !home || alreadyImpacted(id, buildingRect(building, home))) continue;
    const candidates = after.blocks.flatMap((block) => block.parcels)
      .map((parcel) => ({ parcel, d: Math.hypot(parcel.x - home.x, parcel.z - home.z) }))
      .filter(({ parcel, d }) => d <= SEARCH_RADIUS && parcel.id !== home.id)
      .sort((x, y) => x.d - y.d || (x.parcel.id < y.parcel.id ? -1 : 1));
    // 先用 O(1) 的占用集合筛（被占的地块完整校验必然报 parcel-occupied，结果不变），再对剩下的做完整校验。
    const taken = reservedParcelIdsShared(after, next.suppressedContext);
    const pending = new Set(Object.entries(next.buildingMoves).filter(([other]) => other !== id).map(([, parcelId]) => parcelId));
    const target = candidates.find(({ parcel }) => {
      if (taken.has(parcel.id) || pending.has(parcel.id)) return false;
      if (validateBuildingMove(after, model, next, id, parcel.id).blockers.length > 0) return false;
      // Generic move validation protects the parcel proxy against highways. For a
      // newly drawn deck, also validate the renderer-sized building rectangle:
      // a parcel can clear the deck while the actual session building still sits
      // beneath it.
      return rectClearOfEdges(buildingRect(building, parcel), newViaducts, 0.5);
    })?.parcel;
    if (!target) { result.homeless.push(id); continue; }
    next = { ...next, buildingMoves: { ...next.buildingMoves, [id]: target.id }, moveAnchors: { ...next.moveAnchors, [id]: { x: target.x, z: target.z } } };
    after = applyPlanPatch(generated, next).layout;
    result.relocated.push({ id, to: target.id });
  }
  result.patch = next;
  return result;
}
