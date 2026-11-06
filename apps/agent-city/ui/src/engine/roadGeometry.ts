import { EXPRESSWAY_DECK_WIDTH } from "./roadStandard";
import { DetMath as Math } from "./detMath"; // 跨引擎确定性：见 detMath.ts
// 道路几何叶子工具（CITY_PLANNER_REFACTOR_SPEC R1）：逐字搬自 cityPlan.ts，打断 planner/* ↔ cityPlan 的运行时循环。
import type { Vec2 } from "./cityLayout";

export function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

export function polygonDistance(p: Vec2, polygon: Vec2[]): number {
  let inside = false; let distance = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]; const b = polygon[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
    distance = Math.min(distance, segmentDistance(p, a, b));
  }
  return inside ? distance : -distance;
}

export const roadNodeId = (p: Vec2): string => `${p.x}:${p.z}`;

/** 路段空间索引：按 CELL 分格，查询只看点周围的格子（全路段逐一算距离是规划生成的主要耗时：profile 里占 60%）。 */
export class SegmentIndex {
  private readonly cell = 60;
  private readonly cells = new Map<string, Array<[Vec2, Vec2]>>();
  constructor(runs: Vec2[][]) { for (const run of runs) for (let i = 1; i < run.length; i += 1) this.add(run[i - 1], run[i]); }
  add(a: Vec2, b: Vec2): void {
    const c = this.cell;
    for (let gx = Math.floor(Math.min(a.x, b.x) / c); gx <= Math.floor(Math.max(a.x, b.x) / c); gx += 1)
      for (let gz = Math.floor(Math.min(a.z, b.z) / c); gz <= Math.floor(Math.max(a.z, b.z) / c); gz += 1) {
        const key = `${gx}:${gz}`;
        const list = this.cells.get(key);
        if (list) list.push([a, b]); else this.cells.set(key, [[a, b]]);
      }
  }
  /** 点到任一路段的距离是否小于 d（d 不超过一个格宽，查询 3×3 格）。 */
  closerThan(p: Vec2, d: number): boolean {
    const gx = Math.floor(p.x / this.cell); const gz = Math.floor(p.z / this.cell);
    const reach = Math.ceil(d / this.cell);
    for (let dx = -reach; dx <= reach; dx += 1) for (let dz = -reach; dz <= reach; dz += 1) {
      const list = this.cells.get(`${gx + dx}:${gz + dz}`);
      if (list) for (const [a, b] of list) if (segmentDistance(p, a, b) < d) return true;
    }
    return false;
  }
}

/** Conservative footprint guard: includes the full deck and a sidewalk setback. */
export function clearsHighways(p: Vec2, width: number, depth: number, highways: Vec2[][] | SegmentIndex): boolean {
  const clearance = EXPRESSWAY_DECK_WIDTH / 2 + Math.hypot(width, depth) / 2 + 1;
  if (highways instanceof SegmentIndex) return !highways.closerThan(p, clearance);
  for (const run of highways) for (let i = 1; i < run.length; i += 1) {
    if (segmentDistance(p, run[i - 1], run[i]) < clearance) return false;
  }
  return true;
}
