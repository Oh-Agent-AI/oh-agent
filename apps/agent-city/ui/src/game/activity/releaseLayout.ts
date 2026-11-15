/**
 * 发布锚点并回实机视图（2026-11-15 飞行管线发现的结构缺口）。
 *
 * 两条数据在不同的地方：
 * - **锚点**（含 `air-gate:*` 这类 Creator 新增的空域门）只存在于发布时的布局快照
 *   （`creator_city_layouts_v2.snapshot_json`）里；
 * - **几何**（`positionMeters` / `activationRadiusMeters`）只存在于实机 City 适配器
 *   里——快照明确不序列化几何。
 *
 * 试玩 claim 走的是实机视图（`createSdkViewForCityLayout`），它只认识路网锚点，于是
 * `validateMount` 会以 `anchor_not_found` 拒绝「锚点在快照里」的发布物。这里把快照锚点
 * **连同它们之间的 link** 并进视图副本：`validateMount` 还要求每个绑定槽从入口沿 link
 * 可达（缺 link 是 `anchor_unreachable`，2026-11-15 的三个 air-gate 就是这个状态）。
 * `geometryRef` 必须在实机几何里存在（同 worldRevision 才成立，调用方已校验），否则如实
 * 报错，绝不把门放到猜出来的位置。
 *
 * 空域门还有一个几何缺口：它只能复用路网节点（`city-road-node:*`），而节点几何**没有**
 * 触发半径（只有路段中点有）。没有半径的 zone 会让 `createMountedMiniGamePlan` 直接
 * 失败（`zone_geometry_unavailable`），发布出来也玩不了。因此这里给这类 zone 一个
 * **显式、有名字的默认触发球**——它是玩法内容常量，不是物理推导；正式做法应是
 * 锚点创作时自带半径（见 docs/CITY_GAME_MCP.md 的 known gap）。
 */
import type { CityLayoutSnapshotV2, DiagnosticV1 } from "@agent-vitals/city-sdk";
import type { CityLayoutSdkViewV1 } from "../../engine/sdk/cityLayoutAdapter";

/** 空域 zone 缺触发半径时的默认触发球（米）。固定 12 m ≈ 一座检查点门，
 *  与 `FlightParams.planeRadius` 同量级，确保固定翼一次穿越必然落在球内。 */
export const RELEASE_ZONE_DEFAULT_RADIUS_METERS = 12;

const error = (code: string, path: string, message: string, objectId?: string): DiagnosticV1 => ({
  code, severity: "error", path, ...(objectId ? { objectId } : {}), message,
});

export type ReleaseAnchorMerge =
  | { ok: true; view: CityLayoutSdkViewV1; addedAnchorIds: readonly string[]; defaultedRadiusRefs: readonly string[] }
  | { ok: false; diagnostics: readonly DiagnosticV1[] };

/**
 * 把发布快照的锚点并进实机视图（返回新对象，不改实机视图）。
 *
 * - 同名锚点：`geometryRef` 必须一致，否则判冲突（同 worldRevision 下不该出现）；
 * - 缺失几何的锚点：整份拒绝并列出 id——半份锚点等于把玩法挪了位置；
 * - 缺半径的 zone 锚点：记进 `defaultedRadiusRefs`，调用方应当如实告知用户。
 */
export function mergeReleaseAnchors(view: CityLayoutSdkViewV1, snapshot: CityLayoutSnapshotV2 | null | undefined): ReleaseAnchorMerge {
  if (!snapshot) return { ok: true, view, addedAnchorIds: [], defaultedRadiusRefs: [] };
  const live = new Map(view.layout.anchors.map(anchor => [anchor.id, anchor]));
  const added: Array<CityLayoutSdkViewV1["layout"]["anchors"][number]> = [];
  const defaultedRadiusRefs: string[] = [];
  const missing: string[] = [];
  const conflicts: string[] = [];
  for (const anchor of snapshot.layout.anchors) {
    const existing = live.get(anchor.id);
    if (existing) {
      if (existing.geometryRef !== anchor.geometryRef) conflicts.push(anchor.id);
      continue;
    }
    if (!view.geometry.has(anchor.geometryRef)) { missing.push(anchor.id); continue; }
    added.push(anchor as CityLayoutSdkViewV1["layout"]["anchors"][number]);
    // zone 需要可信触发半径；只在发布作用域内补默认值，实机视图本身不动。
    if (anchor.kind === "zone" && view.geometry.get(anchor.geometryRef)?.activationRadiusMeters === undefined) {
      defaultedRadiusRefs.push(anchor.geometryRef);
    }
  }
  if (conflicts.length) {
    return { ok: false, diagnostics: [error("release_anchor_conflict", "layout.anchors",
      "Published anchors disagree with the live City geometry for the same anchor id.", conflicts[0])] };
  }
  if (missing.length) {
    return { ok: false, diagnostics: [error("release_anchor_geometry_unavailable", "layout.anchors",
      "The live City has no trusted geometry for a published anchor (world revision mismatch?).", missing[0])] };
  }
  if (!added.length && !defaultedRadiusRefs.length) return { ok: true, view, addedAnchorIds: [], defaultedRadiusRefs: [] };
  // link 也要并：入口 → 门的可达性是 mount 校验的一部分，只有锚点没有 link 仍然
  // `anchor_unreachable`。只并两端都在合并后锚点集合里的 link（镜像快照里删锚点时会
  // 连带删 link 的既有规则）。
  const mergedIds = new Set([...live.keys(), ...added.map(anchor => anchor.id)]);
  const linkIds = new Set(view.layout.links?.map(link => link.id) ?? []);
  const addedLinks = (snapshot.layout.links ?? []).filter(link => !linkIds.has(link.id)
    && mergedIds.has(link.fromAnchorId) && mergedIds.has(link.toAnchorId)
    && link.capabilities.every(capability => [...live.values(), ...added].some(anchor => anchor.id === link.fromAnchorId && anchor.capabilities.includes(capability))
      && [...live.values(), ...added].some(anchor => anchor.id === link.toAnchorId && anchor.capabilities.includes(capability))));
  const geometry = new Map(view.geometry);
  for (const ref of defaultedRadiusRefs) {
    const entry = geometry.get(ref);
    if (entry && entry.activationRadiusMeters === undefined) {
      geometry.set(ref, { ...entry, activationRadiusMeters: RELEASE_ZONE_DEFAULT_RADIUS_METERS });
    }
  }
  // 不改实机视图也不改它的数组：新建一份（类型上 layout.anchors 是可变数组，靠约定不写回）。
  const merged: CityLayoutSdkViewV1 = {
    ...view,
    layout: { ...view.layout, anchors: [...view.layout.anchors, ...added], links: [...(view.layout.links ?? []), ...addedLinks] },
    geometry,
  };
  return { ok: true, view: merged, addedAnchorIds: added.map(anchor => anchor.id), defaultedRadiusRefs };
}
