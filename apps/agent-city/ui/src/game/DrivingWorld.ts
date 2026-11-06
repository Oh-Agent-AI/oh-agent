/** Synthetic driving-surface spike. CityLayout adapters are intentionally a later gate.
 * Rectangular plane patches + explicit same-layer connections. Static XZ rectangles
 * use continuous swept SAT against a conservatively rotation-expanded vehicle OBB.
 */
import type { DrivingEnvironment, DrivingMotion, DrivingMoveResult, DrivingState } from "./DrivingSimulation";
import { DRIVING_FOOTPRINT } from "./driving/vehicleFootprint";
export { DRIVING_FOOTPRINT } from "./driving/vehicleFootprint";
export type DrivingSurface = {
  id: string; layer: string; minX: number; maxX: number; minZ: number; maxZ: number;
  /** y = base + slopeX*x + slopeZ*z */
  base: number; slopeX: number; slopeZ: number; connections: readonly string[];
};
export type DrivingObstacle = { id: string; minX: number; maxX: number; minZ: number; maxZ: number; layer: string };
const EPS = 1e-7;
const height = (s: DrivingSurface, x: number, z: number) => s.base + s.slopeX * x + s.slopeZ * z;
const contains = (s: DrivingSurface, x: number, z: number) => x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ;

export class DrivingWorld implements DrivingEnvironment {
  readonly surfaces: readonly DrivingSurface[];
  readonly obstacles: readonly DrivingObstacle[];
  constructor(surfaces: readonly DrivingSurface[], obstacles: readonly DrivingObstacle[]) {
    // Own an immutable snapshot; callers cannot alter an active run through source objects.
    this.surfaces = Object.freeze(surfaces.map((s) => Object.freeze({ ...s, connections: Object.freeze([...s.connections]) })));
    this.obstacles = Object.freeze(obstacles.map((o) => Object.freeze({ ...o })));
  }

  sampleSupport(x: number, z: number, previousSurfaceId: string, previousY: number): DrivingSurface | null {
    const prior = this.surfaces.find((s) => s.id === previousSurfaceId);
    if (!prior) return null;
    const candidates = this.surfaces.filter((s) =>
      (s.id === prior.id || prior.connections.includes(s.id)) && s.layer === prior.layer &&
      contains(s, x, z) && Math.abs(height(s, x, z) - previousY) <= 0.25 &&
      Math.hypot(s.slopeX, s.slopeZ) <= 0.35);
    return candidates.find((s) => s.id === prior.id) ?? (candidates.length === 1 ? candidates[0] : null);
  }

  private support(motion: DrivingMotion, prior: DrivingState): DrivingSurface | null {
    const c = Math.cos(motion.heading); const s = Math.sin(motion.heading);
    const center = this.sampleSupport(motion.x, motion.z, prior.surfaceId, prior.y);
    if (!center) return null;
    // Four tires AND full body corners need support; unvalidated shoulders are closed.
    for (const [hx, hz] of [[DRIVING_FOOTPRINT.halfLength, DRIVING_FOOTPRINT.halfWidth], [DRIVING_FOOTPRINT.wheelbase / 2, DRIVING_FOOTPRINT.track / 2]]) {
      for (const a of [-1, 1]) for (const b of [-1, 1]) {
        const x = motion.x + a * hx * c - b * hz * s;
        const z = motion.z + a * hx * s + b * hz * c;
        if (!this.sampleSupport(x, z, center.id, height(center, x, z))) return null;
      }
    }
    return center;
  }

  private sweptHit(previous: DrivingState, desired: DrivingMotion): boolean {
    const mid = (previous.heading + desired.heading) / 2;
    const c = Math.cos(mid); const s = Math.sin(mid);
    const padding = Math.hypot(DRIVING_FOOTPRINT.halfLength, DRIVING_FOOTPRINT.halfWidth) * Math.abs(desired.heading - previous.heading) / 2 + EPS;
    const layer = this.surfaces.find((surface) => surface.id === previous.surfaceId)?.layer;
    for (const obstacle of this.obstacles) {
      if (obstacle.layer !== layer) continue;
      const ox = (obstacle.minX + obstacle.maxX) / 2; const oz = (obstacle.minZ + obstacle.maxZ) / 2;
      const ex = (obstacle.maxX - obstacle.minX) / 2; const ez = (obstacle.maxZ - obstacle.minZ) / 2;
      let enter = 0; let exit = 1;
      for (const [ax, az] of [[1, 0], [0, 1], [c, s], [-s, c]]) {
        const radius = ex * Math.abs(ax) + ez * Math.abs(az) +
          (DRIVING_FOOTPRINT.halfLength + padding) * Math.abs(ax * c + az * s) + (DRIVING_FOOTPRINT.halfWidth + padding) * Math.abs(-ax * s + az * c);
        const origin = (previous.x - ox) * ax + (previous.z - oz) * az;
        const velocity = (desired.x - previous.x) * ax + (desired.z - previous.z) * az;
        if (Math.abs(velocity) < EPS) {
          if (Math.abs(origin) > radius) { enter = 2; break; }
        } else {
          const a = (-radius - origin) / velocity; const b = (radius - origin) / velocity;
          enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
          if (enter > exit) break;
        }
      }
      if (enter <= exit && enter <= 1 && exit >= 0) return true;
    }
    return false;
  }

  move(previous: DrivingState, desired: DrivingMotion): DrivingMoveResult {
    const rejected = (reason: string): DrivingMoveResult => ({ ...previous, blocked: true, reason });
    if (![desired.x, desired.z, desired.heading].every(Number.isFinite)) return rejected("invalid-motion");
    if (this.sweptHit(previous, desired)) return rejected("obstacle");
    // Check intermediate support too; a fast step cannot jump across a surface gap.
    const steps = Math.max(1, Math.ceil(Math.hypot(desired.x - previous.x, desired.z - previous.z) / 0.1), Math.ceil(Math.abs(desired.heading - previous.heading) / 0.02));
    if (steps > 1000) return rejected("step-budget");
    let surface: DrivingSurface | null = null;
    let cursor = previous;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const point = { x: previous.x + (desired.x - previous.x) * t, z: previous.z + (desired.z - previous.z) * t, heading: previous.heading + (desired.heading - previous.heading) * t };
      surface = this.support(point, cursor);
      if (!surface) return rejected("no-support");
      cursor = { ...cursor, ...point, y: height(surface, point.x, point.z), surfaceId: surface.id };
    }
    if (!surface) return rejected("no-support");
    const c = Math.cos(desired.heading); const s = Math.sin(desired.heading);
    return { ...desired, y: height(surface, desired.x, desired.z), surfaceId: surface.id,
      pitch: Math.atan(surface.slopeX * c + surface.slopeZ * s),
      roll: Math.atan(-surface.slopeX * s + surface.slopeZ * c), blocked: false };
  }
}
