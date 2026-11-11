/**
 * 高架立交匝道（2026-10-15，CITY_ROAD_NETWORK_SPEC §5「立交：高架与地面路交叉——上下穿；可选匝道（后续）」的落地）。
 *
 * 用户：「闸道应该是高架桥道路和普通道路交接转化的地方」。环线高架（layout.highways）是架空结构、不在 roadEdges 里，
 * 跨越地面干道时只是从上面掠过，没有任何上下联系。这里在高架跨越干道处做标准的菱形立交（diamond interchange）：
 * 高架两侧各两条匝道——行车方向上「跨越点之前下、之后上」——与高架平行、外移 RAMP_OFFSET，从桥面高度渐降到地面，
 * 在干道上以 T 口落地（匝道与干道的夹角 = 高架与干道的夹角 ≥ MIN_CROSS_ANGLE）。
 *
 * 选址：跨越角 ≥ 50°；匝道桥面端离开放高架断头 ≥ END_CLEAR（避开高架自身的落地坡）；沿高架间距 ≥ SPACING，每条最多 MAX_PER_HIGHWAY 处。
 * 校验（逐条匝道，不过就丢这一条）：走廊全可建、不压公共用地/地标（半径 + 匝道半宽 + 2）；低段（路程 65%–90%）不贴近干道之外的地面路
 * ——前段架在空中，跨过地面路没问题。
 * 匝道折线由「桥面端 → 地面端」排列；高度由渲染层按路程从桥面平滑降到地面（规划层不碰高度）。
 * 匝道走廊随后与高架一并作为街区生成的避让（cityPlan 把它们并进 generateRoadBlocks 的 highways），地块会让开。
 */
import { atLeast, roadWidthFor } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import type { RoadEdge, Vec2 } from "../cityLayout";
import { segmentDistance } from "../roadGeometry";

export const HIGHWAY_RAMP_CONFIG = {
  version: 1,
  /** 匝道中线离高架中线的横向距离：桥面半宽 5.25 + 间隙 + 匝道半宽 3.5。曾取 13（间隙只剩 ~8 m），
   *  俯视像高架多了两条侧车道，菱形读不出来；22 分得开但撞街道的多（通过的匝道 18 → 7），取 17（间隙 ~16 m）。 */
  offset: 17,
  /** 匝道沿高架方向的长度（桥面端到跨越点的纵向距离）：桥面底高 8.2，前段同高分流后平滑下降。 */
  length: 110,
  /** 匝道桥面宽（单车道 + 路肩）。 */
  width: 7,
  minCrossAngleDeg: 50,
  endClear: 90,
  spacing: 400,
  maxPerHighway: 2,
  /** 匝道离其他地面路的最小净距（中线到路缘）。 */
  roadClear: 1.5,
  /** 只在匝道低段（路程比例区间）检查与地面路的净距：前段架在空中，从地面路上方经过没问题；末段落在干道 T 口。 */
  groundCheck: [0.65, 0.9] as const,
  step: 6,
};

export type HighwayRamp = { points: Vec2[]; width: number; side: 1 | -1 };

type Crossing = { highway: number; s: number; at: Vec2; dir: Vec2; artDir: Vec2; edge: RoadEdge; angle: number };

const unit = (v: Vec2): Vec2 => { const l = Math.hypot(v.x, v.z) || 1; return { x: v.x / l, z: v.z / l }; };

export function planHighwayRamps(opts: {
  highways: readonly (readonly Vec2[])[];
  roads: readonly RoadEdge[];
  buildable: (x: number, z: number) => boolean;
  sites: ReadonlyArray<{ x: number; z: number; radius: number }>;
}): { ramps: HighwayRamp[]; interchanges: Vec2[] } {
  const C = HIGHWAY_RAMP_CONFIG;
  const ground = opts.roads.filter((e) => !e.bridge && e.structure !== "deck");
  const ramps: HighwayRamp[] = [];
  const interchanges: Vec2[] = [];
  opts.highways.forEach((run, h) => {
    const closed = run.length > 2 && Math.hypot(run[0].x - run[run.length - 1].x, run[0].z - run[run.length - 1].z) < 0.01;
    const along: number[] = [0];
    for (let i = 1; i < run.length; i += 1) along.push(along[i - 1] + Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z));
    const total = along[along.length - 1];
    const crossings: Crossing[] = [];
    for (let i = 1; i < run.length; i += 1) {
      const a = run[i - 1], b = run[i];
      const dir = unit({ x: b.x - a.x, z: b.z - a.z });
      for (const edge of ground) {
        if (edge.width < roadWidthFor("collector")) continue;
        for (let j = 1; j < edge.points.length; j += 1) {
          const c = edge.points[j - 1], d = edge.points[j];
          const ux = b.x - a.x, uz = b.z - a.z, vx = d.x - c.x, vz = d.z - c.z;
          const det = ux * vz - uz * vx; if (Math.abs(det) < 1e-9) continue;
          const t = ((c.x - a.x) * vz - (c.z - a.z) * vx) / det, u = ((c.x - a.x) * uz - (c.z - a.z) * ux) / det;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const artDir = unit({ x: vx, z: vz });
          const angle = Math.acos(Math.min(1, Math.abs(dir.x * artDir.x + dir.z * artDir.z)));
          if (angle < (C.minCrossAngleDeg * Math.PI) / 180) continue;
          const s = along[i - 1] + t * Math.hypot(ux, uz);
          if (!closed && (s < C.length + C.endClear || total - s < C.length + C.endClear)) continue;
          crossings.push({ highway: h, s, at: { x: a.x + ux * t, z: a.z + uz * t }, dir, artDir, edge, angle });
        }
      }
    }
    // 宽路优先，其次更接近直角，再按路程（确定性）。
    crossings.sort((p, q) => q.edge.width - p.edge.width || q.angle - p.angle || p.s - q.s);
    const chosen: Crossing[] = [];
    for (const crossing of crossings) {
      if (chosen.length >= C.maxPerHighway) break;
      if (chosen.some((other) => { const distance = Math.abs(other.s - crossing.s); return (closed ? Math.min(distance, total - distance) : distance) < C.spacing; })) continue;
      const built = buildDiamond(crossing, ground, opts, run, along, closed);
      if (built.length >= 2) { chosen.push(crossing); ramps.push(...built); interchanges.push(crossing.at); }
    }
  });
  return { ramps, interchanges };
}

/** 一处菱形立交：两侧 × 前后共 4 条匝道，逐条校验，留下通过的。 */
function buildDiamond(crossing: Crossing, ground: readonly RoadEdge[], opts: Parameters<typeof planHighwayRamps>[0], run: readonly Vec2[], along: readonly number[], closed: boolean): HighwayRamp[] {
  const C = HIGHWAY_RAMP_CONFIG;
  const { at, dir, artDir } = crossing;
  const out: HighwayRamp[] = [];
  const total = along[along.length - 1];
  const sample = (distance: number) => {
    const s = closed ? ((distance % total) + total) % total : Math.max(0, Math.min(total, distance));
    let i = 1;
    while (i < along.length - 1 && along[i] < s) i += 1;
    const a = run[i - 1], b = run[i], t = (s - along[i - 1]) / (along[i] - along[i - 1] || 1);
    return { point: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, dir: unit({ x: b.x - a.x, z: b.z - a.z }) };
  };
  for (const side of [1, -1] as const) {
    const normal = { x: -dir.z * side, z: dir.x * side };
    // 落地点：干道与「离高架中线 offset 的平行线」的交点（干道方向取朝这一侧的那头）。
    const toward = artDir.x * normal.x + artDir.z * normal.z >= 0 ? artDir : { x: -artDir.x, z: -artDir.z };
    const sin = Math.abs(toward.x * normal.x + toward.z * normal.z);
    if (sin < 0.5) continue;
    const landing = { x: at.x + toward.x * (C.offset / sin), z: at.z + toward.z * (C.offset / sin) };
    // 落点必须属于实际宿主折线，不能只落在宿主无限延长线上。
    // 路口会把同一条干道拆成多条边，落点可在相邻的共线宿主边上，但必须存在真实路段。
    const host = ground.find((edge) => atLeast(edge, "collector") && edge.points.slice(1).some((p, i) => {
      const a = edge.points[i], direction = unit({ x: p.x - a.x, z: p.z - a.z });
      return Math.abs(direction.x * artDir.x + direction.z * artDir.z) > 0.99 && segmentDistance(landing, a, p) < 0.02;
    }));
    if (!host) continue;
    for (const ahead of [-1, 1] as const) {
      // 桥面端：跨越点前（ahead=-1）或后（+1）length 处、贴着高架桥面边（横向从高架中线起步）；前 40% 路程沿实际高架 smoothstep 外移到 offset，
      // 后 60% 沿 offset 平行线直走到干道上的落地点（落地点本身就在这条平行线上）。
      // 沿真实高架采样：局部切线的延长线在弯道上会离开桥面，原 0.55·offset 起点还会留下悬空间隙。
      const merge = sample(crossing.s + C.length * ahead * 0.6);
      const shifted = { x: merge.point.x - merge.dir.z * side * C.offset, z: merge.point.z + merge.dir.x * side * C.offset };
      const points: Vec2[] = [];
      const steps = Math.ceil(C.length / C.step);
      for (let k = 0; k <= steps; k += 1) {
        const q = k / steps;
        if (q <= 0.4) {
          const w = q / 0.4, e = w * w * (3 - 2 * w);
          const lateral = C.offset * e;
          const highway = sample(crossing.s + C.length * ahead * (1 - 0.4 * w));
          points.push({ x: highway.point.x - highway.dir.z * side * lateral, z: highway.point.z + highway.dir.x * side * lateral });
        } else {
          const w = (q - 0.4) / 0.6;
          points.push({ x: shifted.x + (landing.x - shifted.x) * w, z: shifted.z + (landing.z - shifted.z) * w });
        }
      }
      if (rampClear(points, host, ground, opts)) out.push({ points, width: C.width, side });
    }
  }
  return out;
}

function rampClear(points: readonly Vec2[], host: RoadEdge, ground: readonly RoadEdge[], opts: Parameters<typeof planHighwayRamps>[0]): boolean {
  const C = HIGHWAY_RAMP_CONFIG;
  const half = C.width / 2;
  for (let k = 0; k < points.length; k += 1) {
    const p = points[k];
    if (!opts.buildable(p.x, p.z)) return false;
    if (opts.sites.some((site) => Math.hypot(site.x - p.x, site.z - p.z) < site.radius + half + 2)) return false;
    const q = k / (points.length - 1);
    if (q < C.groundCheck[0] || q > C.groundCheck[1]) continue;
    for (const road of ground) {
      if (road.id === host.id) continue;
      for (let j = 1; j < road.points.length; j += 1) {
        if (segmentDistance(p, road.points[j - 1], road.points[j]) < road.width / 2 + half + C.roadClear) return false;
      }
    }
  }
  return true;
}
