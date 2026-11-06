/**
 * 小地图的路况（2026-10-21，用户：「可以搞个小地图，这样可以明显的看出道路情况？」）。
 *
 * 纯函数，读玩家眼前的城市（补丁后的生效布局），给每段路一个路况，给每个问题一个点：
 *   - 开不过去（红）：坡比 > 车的爬坡上限 0.31 的地面路、斜接/陡岸桥头所在的整座桥；
 *   - 很陡（琥珀）：坡比 0.2–0.31；
 *   - 正常：按路型（主干道 / 次干道 / 小路 / 桥 / 高架）着色。
 * 判据与修复面板「体检」的道路规则是同一组函数（planGeometry.bridgeheadDefects / polylineMaxGrade），
 * 小地图上看见的红点，体检里就有一条同样的问题、能「定位」「修复方案」。按布局缓存（布局不可变，补丁每次产出新布局）。
 */
import type { CityLayout, Vec2 } from "../engine/cityLayout";
import { bridgeheadDefects, isWater, polylineMaxGrade, ROAD_MAX_GRADE, ROAD_STEEP_GRADE } from "../engine/planGeometry";

export type RoadCondition = "ok" | "steep" | "blocked";
export type RoadClass = "main" | "secondary" | "local" | "bridge";
export type MinimapRoad = { id: string; points: readonly Vec2[]; width: number; cls: RoadClass; condition: RoadCondition };
export type MinimapIssue = { at: Vec2; kind: "bridgehead-oblique" | "bridgehead-steep" | "road-steep"; severity: "blocked" | "steep"; text: { zh: string; en: string } };
/** 水陆栅格：按地形高 ≤ 水位（生成器与画路工具同一水位）逐格取样——海湾、河、小岛都按真实地形画，不靠外海岸线多边形。 */
export type MinimapWater = { cols: number; rows: number; water: Uint8Array };
export type MinimapModel = {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  coast: readonly Vec2[];
  water: MinimapWater;
  roads: readonly MinimapRoad[];
  highways: readonly (readonly Vec2[])[];
  issues: readonly MinimapIssue[];
  counts: { blocked: number; steep: number };
  /** 车开不过去的路（红）：车流估算把它们排除在路网外（traffic.ts）。 */
  blocked: ReadonlySet<string>;
};

const cache = new WeakMap<CityLayout, MinimapModel>();

export function minimapModel(layout: CityLayout): MinimapModel {
  const hit = cache.get(layout);
  if (hit) return hit;
  const issues: MinimapIssue[] = [];
  const blockedEdges = new Set<string>();
  for (const defect of bridgeheadDefects(layout)) {
    for (const id of defect.deckIds) blockedEdges.add(id);
    issues.push(defect.kind === "oblique"
      ? { at: defect.at, kind: "bridgehead-oblique", severity: "blocked", text: { zh: `桥头斜接：下桥要转 ${Math.round(defect.skewDeg)}°，车身会越出桥面`, en: `Oblique bridgehead: a ${Math.round(defect.skewDeg)}° turn off the bridge, cars run off the deck` } }
      : { at: defect.at, kind: "bridgehead-steep", severity: "blocked", text: { zh: `桥头岸坡太陡（坡比 ${defect.grade.toFixed(2)}），车上不了桥`, en: `Steep bridgehead (grade ${defect.grade.toFixed(2)}): cars can't get onto the bridge` } });
  }
  const roads: MinimapRoad[] = layout.roadEdges.map((edge) => {
    const deck = edge.bridge === true || edge.structure === "deck";
    const cls: RoadClass = deck ? "bridge" : edge.width >= 12 ? "main" : edge.width >= 8 ? "secondary" : "local";
    let condition: RoadCondition = blockedEdges.has(edge.id) ? "blocked" : "ok";
    if (!deck) {
      const { grade, at } = polylineMaxGrade(layout, edge.points);
      if (grade > ROAD_MAX_GRADE && at) { condition = "blocked"; issues.push({ at, kind: "road-steep", severity: "blocked", text: { zh: `陡路：坡比 ${grade.toFixed(2)}，车开不上去`, en: `Steep road: grade ${grade.toFixed(2)}, cars can't climb it` } }); }
      else if (grade > ROAD_STEEP_GRADE && at) { if (condition === "ok") condition = "steep"; issues.push({ at, kind: "road-steep", severity: "steep", text: { zh: `陡路：坡比 ${grade.toFixed(2)}，接近车的爬坡上限`, en: `Steep road: grade ${grade.toFixed(2)}, close to what cars can climb` } }); }
    }
    return { id: edge.id, points: edge.points, width: edge.width, cls, condition };
  });
  // 范围：海岸线 + 全部路点（循环取极值——4000 楼的城市路点上万，展开参数会撑爆调用栈）。
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const grow = (p: Vec2) => { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z; };
  for (const p of layout.coast ?? []) grow(p);
  for (const road of roads) for (const p of road.points) grow(p);
  const pad = 20;
  const bounds = Number.isFinite(minX) ? { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad }
    : { minX: -layout.extent, maxX: layout.extent, minZ: -layout.extent, maxZ: layout.extent };
  const cols = 256, rows = Math.max(16, Math.round(cols * (bounds.maxZ - bounds.minZ) / Math.max(1, bounds.maxX - bounds.minX)));
  const water = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) {
    const x = bounds.minX + ((c + 0.5) / cols) * (bounds.maxX - bounds.minX), z = bounds.minZ + ((r + 0.5) / rows) * (bounds.maxZ - bounds.minZ);
    water[r * cols + c] = isWater(layout, x, z) ? 1 : 0;
  }
  const model: MinimapModel = {
    bounds, coast: layout.coast ?? [], water: { cols, rows, water }, roads, highways: layout.highways ?? [], issues,
    counts: { blocked: issues.filter((issue) => issue.severity === "blocked").length, steep: issues.filter((issue) => issue.severity === "steep").length },
    blocked: new Set(roads.filter((road) => road.condition === "blocked").map((road) => road.id)),
  };
  cache.set(layout, model);
  return model;
}
