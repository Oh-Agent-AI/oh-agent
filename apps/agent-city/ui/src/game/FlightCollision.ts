/**
 * FlightCollision（§6.3）：飞机包围球对前后位置的扫掠检测——不只测当前点。
 * 楼体走「外扩 r 的 AABB 线段滑动测试」（空间网格窗口），地形按段步进（步距 ≤ r/2），
 * 水面并入地形（地面 = max(0, terrain)）。碰撞不终止模拟，由会话层做温和重置。
 */
import type { FlightWorld, ObstacleBox } from "./FlightWorld";

export type SweepPoint = { x: number; y: number; z: number };

export type CollisionHit =
  | { kind: "box"; t: number }
  | { kind: "terrain"; t: number }
  | { kind: "bounds"; t: number };

/** 线段 [from,to] 与外扩 radius 的 AABB 是否相交；命中返回 t∈[0,1]，未命中返回 1e9。 */
function segmentBox(from: SweepPoint, to: SweepPoint, box: ObstacleBox, radius: number): number {
  const minX = box.minX - radius, maxX = box.maxX + radius;
  const minY = box.minY - radius, maxY = box.maxY + radius;
  const minZ = box.minZ - radius, maxZ = box.maxZ + radius;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  let enter = 0;
  let exit = 1;
  for (const [origin, delta, low, high] of [
    [from.x, dx, minX, maxX], [from.y, dy, minY, maxY], [from.z, dz, minZ, maxZ],
  ] as const) {
    if (delta === 0) {
      if (origin < low || origin > high) return 1e9;
      continue;
    }
    let t0 = (low - origin) / delta;
    let t1 = (high - origin) / delta;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    if (t0 > enter) enter = t0;
    if (t1 < exit) exit = t1;
    if (enter > exit) return 1e9;
  }
  return enter;
}

/** 一步物理（from→to）的扫掠碰撞检测；无碰撞返回 null。 */
export function sweepFlight(world: FlightWorld, from: SweepPoint, to: SweepPoint, radius: number): CollisionHit | null {
  const bounds = world.bounds;
  let best: CollisionHit | null = null;
  const consider = (hit: CollisionHit) => {
    if (!best || hit.t < best.t) best = hit;
  };
  // 硬边界（水平圆）：解二次方程取穿出点。
  const dx = to.x - bounds.centerX;
  const dz = to.z - bounds.centerZ;
  const mx = from.x - bounds.centerX;
  const mz = from.z - bounds.centerZ;
  const r2 = bounds.hardRadius * bounds.hardRadius;
  if (dx * dx + dz * dz > r2 || mx * mx + mz * mz > r2) {
    const vx = to.x - from.x, vz = to.z - from.z;
    const a = vx * vx + vz * vz;
    if (a > 1e-9) {
      const b = 2 * (mx * vx + mz * vz);
      const c = mx * mx + mz * mz - r2;
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t >= 0 && t <= 1) consider({ kind: "bounds", t });
      }
    }
    if (Math.hypot(dx, dz) > bounds.hardRadius) consider({ kind: "bounds", t: 1 });
  }
  // 垂直边界。
  if (to.y < bounds.minY || to.y > bounds.maxY) consider({ kind: "bounds", t: 1 });
  // 地形/水面：段步进，步距由半径约束（保守采样）。
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const steps = Math.max(1, Math.ceil(distance / Math.max(0.5, radius * 0.5)));
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const z = from.z + (to.z - from.z) * t;
    if (y < Math.max(0, world.terrainHeight(x, z)) + radius * 0.5) { consider({ kind: "terrain", t }); break; }
  }
  // 楼体：窗口内逐盒滑动测试。
  const minX = Math.min(from.x, to.x) - radius;
  const maxX = Math.max(from.x, to.x) + radius;
  const minZ = Math.min(from.z, to.z) - radius;
  const maxZ = Math.max(from.z, to.z) + radius;
  for (const box of world.boxesInWindow(minX, minZ, maxX, maxZ)) {
    // 垂直方向差太远的盒子先剔除，省掉滑动测试。
    if (Math.max(box.minY, from.y, to.y) + radius < Math.min(box.maxY, from.y, to.y) - radius) continue;
    const t = segmentBox(from, to, box, radius);
    if (t <= 1) consider({ kind: "box", t });
  }
  return best;
}
