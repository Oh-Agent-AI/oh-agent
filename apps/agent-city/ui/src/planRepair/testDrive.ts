/**
 * 试驾（修复升级 P1-E，docs/CITY_REPAIR_UPGRADE_PLAN.md）：玩家改完一条路或一座桥，问「车开不开得过去」。
 *
 * 在当前生效布局（补丁后的城市，与驾驶模式同一份）上编译驾驶面，用驾驶模式的同一个内核（DrivingKernel +
 * SurfaceDrivingEnvironment）沿这条路双向各开一遍，每 tick 由独立验证器复核。纯 CPU、不碰 three/DOM，可在 node 里测。
 *
 * 只认路面，不载场景固体：问的是「路面接不接得上、坡爬不爬得上」——坏桥头、陡路、桥面越界都是路面问题。
 * 压在路上的楼/设施是另一类问题（体检的楼压路），这里不判。结果三态如实：通过 / 挡住（带位置）/ 未判定（带原因），
 * 未判定不当成坏路（与 RoadPassabilityAudit 的口径一致：跑不通不等于路不通，只有挡住才有位置）。
 *
 * 宽路（≥ 8）沿右侧车道开（车道中心 = 路中线向右 1/4 路宽），窄路沿中线；渠化路口的导流岛另由 keepRightOfIslands 绕开。
 * 桥沿中线开：窄桥两侧是护栏，偏到右车道时桥头接缝处车轮探出桥面（7/2 重画的 5 宽桥实测）。
 */
import { roadWidthFor } from "../engine/roadStandard";
import type { CityLayout, Vec2 } from "../engine/cityLayout";
import { bridgeChain, bridgeChainPolyline, edgeLocked } from "../engine/planPatch";
import { compileCitySurface } from "../engine/surface/compileSurface";
import { channelizedGeometry } from "../engine/surface/structureCompiler";
import { buildSurfaceIndex } from "../engine/surface/SurfaceIndex";
import { buildSurfaceRegions, type SurfaceRegionsBuild } from "../engine/surface/surfaceRegions";
import { DRIVING_DT, initialDrivingState, type DrivingState } from "../game/DrivingSimulation";
import { DrivingKernel } from "../game/driving/DrivingKernel";
import { CurvatureRoutePilot } from "../game/driving/audit/RoutePilot";
import { polylineProgress, SurfaceDrivingEnvironment, SurfaceWorldValidator } from "../game/driving/SurfaceDrivingWorld";
import { DRIVING_FOOTPRINT } from "../game/driving/vehicleFootprint";

export type TestDriveTarget = { kind: "bridge" | "road"; edgeIds: string[]; width: number; /** 试驾路线（路中线；桥含两端各 4 的真实引道）。 */ path: Vec2[] };
export type DriveLeg = { result: "ok" | "blocked" | "undetermined"; reason: string; at: Vec2 | null; driven: number; total: number };
export type TestDriveResult = { target: TestDriveTarget; forward: DriveLeg; back: DriveLeg; verdict: "passed" | "blocked" | "undetermined" };

const IDENTITY = Object.freeze({ baseSnapshotHash: "plan-repair-test-drive", vehicleConfigHash: "car-v1", kernelBuildId: "plan-repair", physicsVersion: 1, collisionVersion: 1, queryVersion: 1 });
const BRIDGE_TAIL = 4;
/** 路的两端各让开这么多（落在路口里的起止点会被别的路的路缘绊住，那不是这条路的事）。 */
const ROAD_END_CLEARANCE = 3;
const CRUISE = 7;

/** 局部驾驶面的外扩：路线包围盒外这么远的整条路段都编进来——离路线最近的路口扇面、桥头落地口、匝道都完整。 */
const WINDOW_MARGIN = 40;
type Box = { minX: number; maxX: number; minZ: number; maxZ: number };
const nearBox = (box: Box, points: readonly Vec2[]) => {
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i], b = points[Math.min(points.length - 1, i + 1)]; const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 10));
    for (let k = 0; k <= steps; k += 1) { const x = a.x + (b.x - a.x) * k / steps, z = a.z + (b.z - a.z) * k / steps; if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ) return true; }
  }
  return false;
};

/** 路线附近的局部布局：只裁对象清单（整条路段/整条高架/整条匝道/整座地标），地形与几何不动。
 *  4000 楼全城编译驾驶面 8.7 s（主线程卡死）；试驾只问这一条路，局部编译与全城在路线附近是同一份几何。 */
function windowAround(layout: CityLayout, path: readonly Vec2[]): CityLayout {
  const box: Box = { minX: Math.min(...path.map((p) => p.x)) - WINDOW_MARGIN, maxX: Math.max(...path.map((p) => p.x)) + WINDOW_MARGIN,
    minZ: Math.min(...path.map((p) => p.z)) - WINDOW_MARGIN, maxZ: Math.max(...path.map((p) => p.z)) + WINDOW_MARGIN };
  const inside = (p: Vec2) => p.x >= box.minX && p.x <= box.maxX && p.z >= box.minZ && p.z <= box.maxZ;
  // 路口闭包：窗口里的路段两端的路口要带上全部入边——少一条腿，路口扇面按剩下的腿重算，几何就不是全城那一份了
  // （弧线接路的抽样里，裁掉一条腿的路口扇面解不出边界，试驾报 unresolved-patch，全城编译里并没有这个洞）。
  const near = layout.roadEdges.filter((edge) => nearBox(box, edge.points));
  const ends = new Set(near.flatMap((edge) => [edge.from, edge.to]));
  return { ...layout,
    roadEdges: layout.roadEdges.filter((edge) => ends.has(edge.from) || ends.has(edge.to)),
    highways: (layout.highways ?? []).filter((run) => nearBox(box, run)),
    highwayRamps: (layout.highwayRamps ?? []).filter((ramp) => nearBox(box, ramp.points)),
    bridges: (layout.bridges ?? []).filter((bridge) => nearBox(box, [bridge.from, bridge.to])),
    landmarks: (layout.landmarks ?? []).filter((landmark) => inside(landmark) || (!!landmark.to && nearBox(box, [landmark, landmark.to]))),
    culDeSacEnds: (layout.culDeSacEnds ?? []).filter(inside) };
}

const regionsCache = new WeakMap<object, Map<string, SurfaceRegionsBuild>>();
/** 路线附近的驾驶区域（按布局 + 路线缓存：布局不可变，补丁每次产出新布局）。 */
export function drivingRegions(layout: CityLayout, path: readonly Vec2[], whole = false): SurfaceRegionsBuild {
  const key = whole ? "whole" : path.map((p) => `${p.x.toFixed(1)}:${p.z.toFixed(1)}`).join("|");
  let byPath = regionsCache.get(layout);
  if (!byPath) { byPath = new Map(); regionsCache.set(layout, byPath); }
  const hit = byPath.get(key);
  if (hit) return hit;
  const local = whole ? layout : windowAround(layout, path);
  const compiled = compileCitySurface(local);
  const surface = { ...compiled.surface, revision: `plan-repair:${layout.seed}:${layout.scaleTier}:${key.length}` };
  const regions = buildSurfaceRegions(surface, buildSurfaceIndex(surface));
  byPath.set(key, regions);
  return regions;
}

const along = (a: Vec2, b: Vec2, s: number): Vec2 => { const d = Math.hypot(b.x - a.x, b.z - a.z) || 1; return { x: a.x + (b.x - a.x) * s / d, z: a.z + (b.z - a.z) * s / d }; };

function trimmed(points: readonly Vec2[], from: number, to: number): Vec2[] {
  const out: Vec2[] = []; let base = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1], b = points[i]; const len = Math.hypot(b.x - a.x, b.z - a.z);
    const s0 = Math.max(from, base), s1 = Math.min(to, base + len);
    if (s1 > s0) { const p = along(a, b, s0 - base), q = along(a, b, s1 - base); if (!out.length) out.push(p); out.push(q); }
    base += len;
  }
  return out;
}

/** 这些折线附近驾驶面里解不出边界的可行驶面片数（surfaceRegions 的 boundary-unresolved：车开到那里脚下没有路面）。 */
export function surfaceHoles(layout: CityLayout, lines: readonly (readonly Vec2[])[]): number {
  const points = lines.flat();
  if (!points.length) return 0;
  const regions = drivingRegions(layout, points);
  if (regions.status !== "ready") return Infinity;
  return regions.report.excluded.filter((entry) => entry.reason === "boundary-unresolved" && entry.kind !== "sidewalk" && entry.kind !== "island").length;
}

/** 这条路/桥的试驾路线。桥：整座（bridgeChain）沿桥轴两端各加 4 的引道；路：整段，两端各让开 3。 */
export function testDriveTarget(layout: CityLayout, edgeId: string): TestDriveTarget | null {
  const edge = layout.roadEdges.find((candidate) => candidate.id === edgeId);
  if (!edge) return null;
  if (edgeLocked(edge)) {
    const chain = bridgeChain(layout.roadEdges, edge); const line = bridgeChainPolyline(chain);
    const a = line[0], b = line[line.length - 1];
    // 两端从真实的引道上开过来：取与离桥方向最一致的地面路走 BRIDGE_TAIL（斜接桥头正是这条路拐得太急）；没有地面路就沿桥轴。
    const approach = (end: Vec2, inner: Vec2): Vec2 => {
      const id = `${end.x}:${end.z}`; const ox = end.x - inner.x, oz = end.z - inner.z, ol = Math.hypot(ox, oz) || 1;
      let best: Vec2 | null = null; let bestDot = -Infinity;
      for (const leg of layout.roadEdges) {
        if (edgeLocked(leg) || (leg.from !== id && leg.to !== id)) continue;
        const pts = leg.from === id ? leg.points : [...leg.points].reverse(); const d = Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z) || 1;
        const dot = ((pts[1].x - pts[0].x) * ox + (pts[1].z - pts[0].z) * oz) / (d * ol);
        if (dot > bestDot) { bestDot = dot; best = along(pts[0], pts[1], Math.min(BRIDGE_TAIL, d * 0.8)); }
      }
      return best ?? along(end, inner, -BRIDGE_TAIL);
    };
    return { kind: "bridge", edgeIds: chain.map((piece) => piece.id), width: edge.width, path: [approach(a, line[1]), ...line, approach(b, line[line.length - 2])] };
  }
  const length = edge.points.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - edge.points[i].x, q.z - edge.points[i].z), 0);
  if (length <= 2 * ROAD_END_CLEARANCE + 1) return null;
  return { kind: "road", edgeIds: [edge.id], width: edge.width, path: trimmed(edge.points, ROAD_END_CLEARANCE, length - ROAD_END_CLEARANCE) };
}

/**
 * 绕开渠化导流岛（司机靠右从岛边过）：玩家画路接到现有路上，可能生成渠化 T 口——喇叭口展宽、口里一座导流岛压在路中线上。
 * 固定的右车道偏移（5 宽路 1.25）正好让车身内侧压上岛（玩家式编辑抽样一半「挡住」都是这个，而喇叭口在岛旁留着 2.4–3.5 的车道）。
 * 锐角汇入（< 50°，渠化的条件）时支路的岛尖离主臂中线只有 ~2.8，伸进主臂的右车道——生成器自己的 15 个渠化口里 12 个
 * 主臂单向「挡住」，几何截面证明旁边有车宽的空当：司机会往左让开，不是路不通。
 * 路线按 1 一步重采样，岛附近的点推到岛空着的一侧（岛缘 + 半车宽 + 0.3），前后 2 内取最大值（再宽就推出喇叭口、压上人行道）。
 */
function keepRightOfIslands(path: readonly Vec2[], islands: ReadonlyArray<{ ring: readonly Vec2[] }>): Vec2[] {
  if (!islands.length || path.length < 2) return [...path];
  const pts: Vec2[] = []; const dirs: Vec2[] = [];
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1], b = path[i]; const len = Math.hypot(b.x - a.x, b.z - a.z); if (len <= 0) continue;
    const u = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    for (let s = 0; s < len; s += 1) { pts.push({ x: a.x + u.x * s, z: a.z + u.z * s }); dirs.push(u); }
  }
  pts.push(path[path.length - 1]); dirs.push(dirs[dirs.length - 1]);
  const hw = DRIVING_FOOTPRINT.halfWidth, hl = DRIVING_FOOTPRINT.halfLength;
  const need = pts.map((p, i) => {
    const u = dirs[i]; const n = { x: -u.z, z: u.x }; let shift = 0; // n 与 rightLane 的偏移方向一致
    for (const island of islands) {
      let lo = Infinity, hi = -Infinity;
      for (const q of island.ring) {
        const along = (q.x - p.x) * u.x + (q.z - p.z) * u.z; if (Math.abs(along) > hl + 1) continue;
        const lat = (q.x - p.x) * n.x + (q.z - p.z) * n.z; lo = Math.min(lo, lat); hi = Math.max(hi, lat);
      }
      if (lo === Infinity) continue;
      if (!(hi > -(hw + 0.3) && lo < hw + 0.3)) continue; // 车身横向范围与岛不相交
      // 从岛空着的一侧过：岛偏右（主臂被锐角支路贴着汇入时，支路的岛尖伸进主臂右车道）就往左让，否则往右让。
      const toLeft = lo - hw - 0.3, toRight = hi + hw + 0.3;
      const want = (lo + hi) / 2 > 0 ? toLeft : toRight;
      if (Math.abs(want) > Math.abs(shift)) shift = want;
    }
    return shift;
  });
  return pts.map((p, i) => {
    let shift = 0; for (let k = Math.max(0, i - 2); k <= Math.min(pts.length - 1, i + 2); k += 1) if (Math.abs(need[k]) > Math.abs(shift)) shift = need[k];
    const n = { x: -dirs[i].z, z: dirs[i].x };
    return shift ? { x: p.x + n.x * shift, z: p.z + n.z * shift } : p;
  });
}

/** 路线向右平移到车道中心（按行驶方向）。 */
function rightLane(path: readonly Vec2[], offset: number): Vec2[] {
  return path.map((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)]; const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: p.x - ((b.z - a.z) / l) * offset, z: p.z + ((b.x - a.x) / l) * offset };
  });
}

function driveLeg(regions: SurfaceRegionsBuild, path: readonly Vec2[]): DriveLeg {
  const lengths = [0]; for (let i = 1; i < path.length; i += 1) lengths.push(lengths[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
  const total = lengths[lengths.length - 1];
  const leg = (result: DriveLeg["result"], reason: string, at: Vec2 | null, driven: number): DriveLeg => ({ result, reason, at, driven, total });
  if (regions.status !== "ready") return leg("undetermined", `surface:${regions.reason}`, null, 0);
  const p0 = path[0]; const heading = Math.atan2(path[1].z - p0.z, path[1].x - p0.x);
  const start = regions.classify(p0.x, p0.z, "ground");
  // 起点不在地面路面上（引道太短、起点落进路口扇面外）——没开就谈不上挡住。
  if (start.status !== "drivable") return leg("undetermined", `start:${start.cause ?? start.status}`, p0, 0);
  const env = new SurfaceDrivingEnvironment(regions);
  const placed = env.place(p0.x, p0.z, heading, start.regionId);
  if (!placed) return leg("undetermined", "start:footprint", p0, 0);
  let state: DrivingState = { ...initialDrivingState(p0.x, p0.z, heading, start.regionId), ...placed };
  const progress = polylineProgress(path);
  const validator = new SurfaceWorldValidator(regions, progress);
  if (validator.validateStart(state) !== "valid") return leg("undetermined", "start:invalid", p0, 0);
  const kernel = new DrivingKernel(env, IDENTITY); const pilot = new CurvatureRoutePilot(path, CRUISE);
  const maxTicks = Math.ceil(total / (2 * DRIVING_DT)) + 600; // 领航员最低 2 m/s
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const s = progress(state);
    if (s >= total - 0.5) return leg("ok", "", null, s);
    const step = kernel.step(state, pilot.input(state));
    const verdict = validator.validate(state, step);
    if (verdict !== "valid") return leg("undetermined", `simulation:${verdict}`, { x: state.x, z: state.z }, s);
    if (step.motion.blocked) return leg("blocked", step.motion.reason ?? "blocked", { x: state.x, z: state.z }, s);
    state = step.state;
  }
  return leg("undetermined", "timeout", { x: state.x, z: state.z }, progress(state));
}

/** 沿这条路/桥双向各开一遍。两向都通 → 通过；任一向挡住 → 挡住（带位置）；其余 → 未判定。 */
/** `whole`：编译全城驾驶面（只给测试对照局部窗口用；面板里恒为局部）。 */
export function testDrive(layout: CityLayout, edgeId: string, whole = false): TestDriveResult | null {
  const target = testDriveTarget(layout, edgeId);
  if (!target) return null;
  const regions = drivingRegions(layout, target.path, whole);
  // 桥沿中线开（窄桥两侧是护栏，车在 5 宽的桥上靠中走；偏到右车道，桥头接缝处车轮会探出桥面）；路沿右车道开（避开导流岛）。
  // 窄路（< 8，单车道宽）也沿中线：5 宽路右车道只剩 0.3 余量，弯道上领航员内切 0.25 就擦人行道（弧线抽样实测）。
  const lane = target.kind === "bridge" || target.width < roadWidthFor("collector") ? 0 : Math.max(0, Math.min(target.width / 4, target.width / 2 - DRIVING_FOOTPRINT.halfWidth - 0.3));
  const islands = channelizedGeometry(windowAround(layout, target.path)).islands;
  const forward = driveLeg(regions, keepRightOfIslands(rightLane(target.path, lane), islands));
  const back = driveLeg(regions, keepRightOfIslands(rightLane([...target.path].reverse(), lane), islands));
  const verdict = forward.result === "blocked" || back.result === "blocked" ? "blocked" : forward.result === "ok" && back.result === "ok" ? "passed" : "undetermined";
  return { target, forward, back, verdict };
}
