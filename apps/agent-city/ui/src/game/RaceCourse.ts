/**
 * RaceCourse（§7.1）：有界确定性穿环路线生成。输入 (FlightWorld 快照, citySeed,
 * courseVersion, physicsVersion, variant) 完全决定输出；重试复用原路线，显式
 * 「新路线」才更新 variant。
 *
 * 2026-10-09 重写：路线**穿越城市**而非绕城海上大弧（用户反馈"环没有固定在楼上面"）。
 * 新策略：从 FlightWorld 障碍盒中选取城市内部的高价值路径点（地标/高楼/桥梁附近
 * 的净空位置），串联成蛇形路径，环高度贴天际线（障碍顶+环半径）而非高空均匀层。
 * 生成失败时降级为城外海面弧线（仍走同一走廊验证）。
 */
import type { FlightWorld, ObstacleBox } from "./FlightWorld";
import type { FlightParams } from "./FlightSimulation";
import { DetMath as Math } from "../engine/detMath";
import { hashSeed } from "../cityModel";

// v3（2026-10-12）：环法线改取相邻弦的角平分线 + 走廊验证加转弯可飞性；同一组环心在 v2/v3
// 下法线不同，courseId 只摘要环心，所以必须升版本，否则旧成绩会挂到几何已变的路线上。
export const COURSE_VERSION = 4;
const RING_COUNT = 12;
const MAX_ATTEMPTS = 8;
const REACTION_SECONDS_AT_MAX = 1.2;
const LIMIT_FACTOR = 1.6;
/**
 * 单环处航向偏转上限（水平面）。物理上由转弯圆判定兜底；这条是给人留的可玩性余量：
 * >135° 的折返要求玩家飞过环再大回环找下一环，HUD 上看不出该往哪转（seed 42 环 8 ≈150°）。
 */
export const MAX_TURN_RAD = (135 * Math.PI) / 180;
/** 升降可用比例：留余量给升降平滑与转弯同时进行。 */
const CLIMB_BUDGET = 0.6;

export type CourseRing = {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  radius: number;
};

export type RaceCourse = {
  kind: "generated" | "fallback";
  rings: CourseRing[];
  timeLimitMs: number;
  referenceMs: number;
  ringRadius: number;
  courseId: string;
  variant: number;
};

export type CourseRequest = {
  world: FlightWorld;
  params: FlightParams;
  citySeed: number;
  physicsVersion: number;
  variant: number;
  /** Static collision compiler/content identity; part of the persistent course key. */
  staticCollisionIdentity?: string;
};

type PathPoint = { x: number; y: number; z: number };

export function generateRaceCourse(request: CourseRequest): RaceCourse | null {
  const { world, params, citySeed, physicsVersion, variant } = request;
  const staticCollisionIdentity = request.staticCollisionIdentity ?? "legacy-no-static-snapshot";
  const bounds = world.bounds;
  const ringRadius = Math.max(8, Math.min(16, params.planeRadius * 3.4));
  const clearance = ringRadius + params.planeRadius * 1.5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const waypoints = pickCityWaypoints(world, citySeed, physicsVersion, variant, attempt, ringRadius, clearance);
    if (!waypoints || waypoints.length < 5) continue;
    const path = smoothOpen(waypoints);
    const rings = placeRings(path, ringRadius, params);
    if (!rings) continue;
    orientRingNormals(rings);
    if (!validateCorridor(world, rings, params, clearance)) continue;
    return finalize(citySeed, physicsVersion, variant, rings, params, "generated", staticCollisionIdentity);
  }

  // 降级：城外海面弧线。
  const arcRings = generateSeaArc(world, params, ringRadius, clearance);
  if (arcRings) return finalize(citySeed, physicsVersion, variant, arcRings.rings, params, "fallback", staticCollisionIdentity);
  return null;
}

/**
 * 从城市内部障碍盒中选取路径点：沿方位角扫描，每个扇区取最高的障碍附近放一个
 * 路径点（在障碍侧方 clearance 距离处，高度=障碍顶+ringRadius）。蛇形穿越。
 */
function pickCityWaypoints(
  world: FlightWorld,
  citySeed: number,
  physicsVersion: number,
  variant: number,
  attempt: number,
  ringRadius: number,
  clearance: number,
): PathPoint[] | null {
  const { bounds } = world;
  const cityBoxes = world.boxes.filter((box) =>
    box.minX > bounds.centerX - bounds.softRadius * 0.7 &&
    box.maxX < bounds.centerX + bounds.softRadius * 0.7 &&
    box.minZ > bounds.centerZ - bounds.softRadius * 0.7 &&
    box.maxZ < bounds.centerZ + bounds.softRadius * 0.7 &&
    box.maxY > 5, // 排除贴地薄板和海面带
  );
  if (cityBoxes.length < 10) return null;

  // 按方位角分扇区，每个扇区取最高的障碍。
  const sectorCount = 7;
  const sectors: (ObstacleBox | null)[] = new Array(sectorCount).fill(null);
  for (const box of cityBoxes) {
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    const angle = Math.atan2(cz - bounds.centerZ, cx - bounds.centerX);
    const sector = Math.floor(((angle + Math.PI) / (Math.PI * 2)) * sectorCount) % sectorCount;
    if (!sectors[sector] || box.maxY > sectors[sector]!.maxY) sectors[sector] = box;
  }

  const waypoints: PathPoint[] = [];
  // 出发点：城外海面（出生点方向）。
  const startAngle = hashSeed(`${citySeed}:${physicsVersion}:${variant}:start:${attempt}`) * Math.PI * 2;
  waypoints.push({
    x: bounds.centerX + Math.cos(startAngle) * world.islandRadius * 1.3,
    y: Math.max(35, bounds.maxY * 0.4),
    z: bounds.centerZ + Math.sin(startAngle) * world.islandRadius * 1.3,
  });

  // 城市路径点：蛇形穿越各扇区的最高障碍。
  const ringOrder = buildSnakeOrder(sectorCount, citySeed, physicsVersion, variant, attempt);
  for (const sectorIndex of ringOrder) {
    const box = sectors[sectorIndex];
    if (!box) continue;
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    // 在障碍侧方放环心：偏移方向取「远离城市中心」侧（沿径向外移到建筑边缘+clearance）。
    const awayX = cx - bounds.centerX;
    const awayZ = cz - bounds.centerZ;
    const dist = Math.hypot(awayX, awayZ) || 1;
    const halfW = (box.maxX - box.minX) / 2;
    const halfD = (box.maxZ - box.minZ) / 2;
    const offset = Math.max(halfW, halfD) + ringRadius + clearance * 0.5;
    const px = cx + (awayX / dist) * offset;
    const pz = cz + (awayZ / dist) * offset;
    // 高度：障碍顶面 + 环半径（环下缘贴楼顶）。
    const py = box.maxY + ringRadius;
    waypoints.push({ x: px, y: py, z: pz });
  }

  // 终点：城外海面（出发方向对侧）。
  waypoints.push({
    x: bounds.centerX + Math.cos(startAngle + Math.PI) * world.islandRadius * 1.3,
    y: Math.max(35, bounds.maxY * 0.4),
    z: bounds.centerZ + Math.sin(startAngle + Math.PI) * world.islandRadius * 1.3,
  });

  // 验证最小路径点数。
  if (waypoints.length < 5) return null;
  return waypoints;
}

/** 蛇形排序：从出发扇区开始，左右交替扫过城市。 */
function buildSnakeOrder(sectorCount: number, citySeed: number, physicsVersion: number, variant: number, attempt: number): number[] {
  const start = Math.floor(hashSeed(`${citySeed}:${physicsVersion}:${variant}:order:${attempt}`) * sectorCount);
  const order: number[] = [];
  let left = (start + 1) % sectorCount;
  let right = (start - 1 + sectorCount) % sectorCount;
  order.push(start);
  while (order.length < sectorCount) {
    if (order.length % 2 === 0) { order.push(right); right = (right - 1 + sectorCount) % sectorCount; }
    else { order.push(left); left = (left + 1) % sectorCount; }
  }
  return order;
}

/** 降级路线：城外海面弧线（不穿城）。 */
function generateSeaArc(world: FlightWorld, params: FlightParams, ringRadius: number, clearance: number): { rings: CourseRing[] } | null {
  const { bounds } = world;
  const radius = Math.min(bounds.softRadius * 0.9, Math.max(world.islandRadius * 1.25, bounds.softRadius * 0.72));
  const phase = hashSeed(`${world.islandRadius}:fallback`) * Math.PI * 2;
  const altitude = Math.max(35, (bounds.maxY - 40) * 0.5 + 30);
  const path: PathPoint[] = [];
  for (let index = 0; index < 7; index += 1) {
    const angle = phase + (index / 7) * Math.PI * 2;
    const x = bounds.centerX + Math.cos(angle) * radius;
    const z = bounds.centerZ + Math.sin(angle) * radius;
    const terrain = Math.max(0, world.terrainHeight(x, z));
    path.push({ x, y: Math.max(altitude, terrain + clearance), z });
  }
  const closed = smoothClosed(path);
  const rings = placeRings(closed, ringRadius, params);
  if (rings) orientRingNormals(rings);
  if (!rings || !validateCorridor(world, rings, params, clearance)) return null;
  return { rings };
}

/** 路线几何摘要。 */
function courseIdentity(citySeed: number, physicsVersion: number, variant: number, rings: CourseRing[], radius: number, staticCollisionIdentity: string): string {
  const digest = rings.map((ring) => `${Math.round(ring.x)},${Math.round(ring.y)},${Math.round(ring.z)}`).join(";");
  return `course:v${COURSE_VERSION}:p${physicsVersion}:${citySeed}:${variant}:${Math.round(hashSeed(`${staticCollisionIdentity}:${digest}`) * 1e9)}:r${Math.round(radius)}`;
}

function finalize(citySeed: number, physicsVersion: number, variant: number, rings: CourseRing[], params: FlightParams, kind: "generated" | "fallback", staticCollisionIdentity: string): RaceCourse {
  let length = 0;
  for (let index = 0; index < rings.length; index += 1) {
    const from = rings[index];
    const to = rings[(index + 1) % rings.length];
    length += Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  }
  const referenceMs = (length / params.cruiseSpeed) * 1000;
  const timeLimitMs = Math.round(referenceMs * LIMIT_FACTOR);
  const courseId = courseIdentity(citySeed, physicsVersion, variant, rings, rings[0].radius, staticCollisionIdentity);
  return { kind, rings, timeLimitMs, referenceMs: Math.round(referenceMs), ringRadius: rings[0].radius, courseId, variant };
}

/** Chaikin 平滑（开放折线：首尾点保留）。 */
function smoothOpen(points: PathPoint[]): PathPoint[] {
  let current = points;
  for (let round = 0; round < 2; round += 1) {
    const next: PathPoint[] = [current[0]];
    for (let index = 0; index < current.length - 1; index += 1) {
      const a = current[index];
      const b = current[index + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

/** Chaikin 平滑（封闭折线）。 */
function smoothClosed(points: PathPoint[]): PathPoint[] {
  let current = points;
  for (let round = 0; round < 2; round += 1) {
    const next: PathPoint[] = [];
    for (let index = 0; index < current.length; index += 1) {
      const a = current[index];
      const b = current[(index + 1) % current.length];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    current = next;
  }
  return current;
}

/** 按弧长等距放 RING_COUNT 个环。 */
function placeRings(path: PathPoint[], ringRadius: number, params: FlightParams): CourseRing[] | null {
  if (path.length < 4) return null;
  const cumulative: number[] = [0];
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1];
    const b = path[index];
    cumulative.push(cumulative[index - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  const total = cumulative[cumulative.length - 1];
  if (!(total > 0)) return null;
  const sampleAt = (distance: number): PathPoint => {
    const target = Math.max(0, Math.min(total, distance));
    let index = 1;
    while (index < cumulative.length - 1 && cumulative[index] < target) index += 1;
    const span = cumulative[index] - cumulative[index - 1] || 1;
    const t = (target - cumulative[index - 1]) / span;
    const a = path[index - 1];
    const b = path[index];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  };
  const rings: CourseRing[] = [];
  const spacing = total / (RING_COUNT - 1); // 开放路径：环数-1 段
  const minSpacing = params.maxSpeed * REACTION_SECONDS_AT_MAX;
  if (spacing < minSpacing) return null;
  for (let index = 0; index < RING_COUNT; index += 1) {
    const distance = index * spacing;
    const point = sampleAt(distance);
    const ahead = sampleAt(Math.min(total, distance + 1));
    const behind = sampleAt(Math.max(0, distance - 1));
    let nx = ahead.x - behind.x, ny = ahead.y - behind.y, nz = ahead.z - behind.z;
    const norm = Math.hypot(nx, ny, nz) || 1;
    if (!Number.isFinite(norm) || norm <= 0) return null;
    nx /= norm; ny /= norm; nz /= norm;
    if (![point.x, point.y, point.z, nx, ny, nz].every(Number.isFinite)) return null;
    rings.push({ x: point.x, y: point.y, z: point.z, nx, ny, nz, radius: ringRadius });
  }
  return rings;
}

/** 整条安全走廊验证。 */
function validateCorridor(world: FlightWorld, rings: CourseRing[], params: FlightParams, clearance: number): boolean {
  const bounds = world.bounds;
  if (!courseTurnFeasible(rings, params)) return false;
  for (let index = 0; index < rings.length; index += 1) {
    const ring = rings[index];
    const next = rings[(index + 1) % rings.length];
    if (!world.isPointClear(ring.x, ring.y, ring.z, ring.radius)) return false;
    if (ring.y < bounds.minY + ring.radius || ring.y > bounds.maxY - ring.radius) return false;
    const spacing = Math.hypot(next.x - ring.x, next.y - ring.y, next.z - ring.z);
    if (spacing < params.maxSpeed * REACTION_SECONDS_AT_MAX) return false;
    const steps = Math.max(2, Math.ceil(spacing / Math.max(4, ring.radius)));
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      const x = ring.x + (next.x - ring.x) * t;
      const y = ring.y + (next.y - ring.y) * t;
      const z = ring.z + (next.z - ring.z) * t;
      if (!world.isPointClear(x, y, z, clearance * 0.8)) return false;
    }
  }
  return true;
}

/**
 * 环法线 = 进/出弦方向的角平分线（首环取出弦、末环取进弦）。
 * 曾取平滑曲线在采样点的切线：环距比曲线弯折粗时，切线与弦可以几乎反向——seed 42 /
 * 40 会话的环 8 法线与来向夹角 148°，飞机只能飞过头再掉头回穿，绕环打转直到超时。
 * 角平分线保证沿弦直飞时与法线夹角 = 偏转角/2（< 90°），始终从背面穿入。
 */
function orientRingNormals(rings: CourseRing[]): void {
  const dirs: PathPoint[] = [];
  for (let index = 0; index < rings.length - 1; index += 1) {
    const a = rings[index];
    const b = rings[index + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
    dirs.push({ x: (b.x - a.x) / length, y: (b.y - a.y) / length, z: (b.z - a.z) / length });
  }
  for (let index = 0; index < rings.length; index += 1) {
    const incoming = dirs[index - 1];
    const outgoing = dirs[index];
    let nx = (incoming?.x ?? 0) + (outgoing?.x ?? 0);
    let ny = (incoming?.y ?? 0) + (outgoing?.y ?? 0);
    let nz = (incoming?.z ?? 0) + (outgoing?.z ?? 0);
    let norm = Math.hypot(nx, ny, nz);
    // 完全折返（平分线退化）：取出弦方向；这种路线随后必被转弯可飞性拒绝。
    if (!(norm > 1e-6) && outgoing) { nx = outgoing.x; ny = outgoing.y; nz = outgoing.z; norm = 1; }
    if (!(norm > 1e-6)) continue;
    rings[index] = { ...rings[index], nx: nx / norm, ny: ny / norm, nz: nz / norm };
  }
}

/**
 * 转弯可飞性（巡航速度、追踪驾驶模型）：飞机沿进弦到达环 i，最坏情况仍朝进弦方向，
 * 要转 θ 才对准环 i+1。下一环必须落在巡航转弯圆之外并留一个环半径余量：
 * L ≥ 2R·sin(min(θ, 90°)) + r（R = cruise/turnRate；切点在圆上时 L = 2R·sinθ）。
 * θ > MAX_TURN_RAD 直接拒绝（可玩性余量，见常量注释）。
 * 另验证升降：巡航飞完该段的时间内，平滑升降率的 CLIMB_BUDGET 足以补齐高差。
 *
 * 曾经的判定把 π−偏转角（内角）当作转角：直线段被当成最难、150° 发卡弯被当成最易，
 * 方向完全反了——seed 42 的发卡弯就这样通过了验证。
 */
export function courseTurnFeasible(rings: CourseRing[], params: FlightParams): boolean {
  const turnRadius = params.cruiseSpeed / params.turnRate;
  for (let index = 0; index + 1 < rings.length; index += 1) {
    const ring = rings[index];
    const next = rings[index + 1];
    const outX = next.x - ring.x, outZ = next.z - ring.z;
    const outLength = Math.hypot(outX, outZ);
    const legLength = Math.hypot(outX, next.y - ring.y, outZ);
    const climb = next.y - ring.y;
    const verticalRate = (climb > 0 ? params.climbRate : params.sinkRate) * CLIMB_BUDGET;
    if (Math.abs(climb) > (legLength / params.cruiseSpeed) * verticalRate) return false;
    if (index === 0) continue;
    const prev = rings[index - 1];
    const inX = ring.x - prev.x, inZ = ring.z - prev.z;
    const inLength = Math.hypot(inX, inZ);
    if (!(inLength > 0) || !(outLength > 0)) return false;
    const cos = (inX * outX + inZ * outZ) / (inLength * outLength);
    const turn = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (turn > MAX_TURN_RAD) return false;
    if (outLength < 2 * turnRadius * Math.sin(Math.min(turn, Math.PI / 2)) + ring.radius) return false;
  }
  return true;
}
