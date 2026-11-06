/** D's RoutePilot: button-only, deterministic, curvature- and heading-aware pursuit of a planned centreline.
 * It reads only the immutable state it is given and the frozen route; it never writes pose/speed/layer,
 * never widens the road, never reads the exit gate. A failed route with this pilot stays pilot-failed
 * (inconclusive) — it is a controller, not evidence (spec §11.5).
 *
 * 为什么 B 的 CorridorPilot 不够：固定 4 的前视距离 + 恒定 7 m/s 巡航，在 90° 路口会把弯切进内侧路缘
 * （合成十字路口 8 个直角转弯全部 pilot-failed）。这里前视随车速变化，目标速度按前方曲率与当前航向误差
 * 降低，误差大时松油门，让最小转弯半径（轴距/tan(最大转角) ≈ 3.5）有机会兑现。 */
import type { DrivingInputState, DrivingState } from "../../DrivingSimulation";
import { polylineProgress } from "../SurfaceDrivingWorld";
import type { RoutePilot } from "./contracts";

export const ROUTE_PILOT_CONTROLLER_VERSION = 2;
type P = Readonly<{ x: number; z: number }>;
export type RoutePilotParams = Readonly<{ minLookahead: number; maxLookahead: number; lookaheadPerSpeed: number;
  /** Lateral acceleration bound for the curvature speed limit (v ≤ √(a·R)). */
  lateralAccel: number; minSpeed: number; previewDistance: number; deadband: number; slowError: number }>;
export const DEFAULT_ROUTE_PILOT_PARAMS: RoutePilotParams = Object.freeze({ minLookahead: 1.8, maxLookahead: 5, lookaheadPerSpeed: 0.35,
  lateralAccel: 3, minSpeed: 2, previewDistance: 8, deadband: 0.015, slowError: 0.35 });

export class CurvatureRoutePilot implements RoutePilot {
  private readonly L: number[]; private readonly progress: (s: Readonly<{ x: number; z: number }>) => number;
  constructor(private readonly path: readonly P[], private readonly cruise: number, private readonly params: RoutePilotParams = DEFAULT_ROUTE_PILOT_PARAMS) {
    if (path.length < 2) throw new Error("invalid-pilot-path");
    this.L = [0]; for (let i = 1; i < path.length; i++) this.L.push(this.L[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
    this.progress = polylineProgress(path);
  }
  private at(s: number): P {
    const total = this.L[this.L.length - 1];
    if (s > total) { const a = this.path[this.path.length - 2], b = this.path[this.path.length - 1]; const l = Math.hypot(b.x - a.x, b.z - a.z) || 1; return { x: b.x + (b.x - a.x) / l * (s - total), z: b.z + (b.z - a.z) / l * (s - total) }; }
    let i = 1; while (i < this.path.length - 1 && this.L[i] < s) i++;
    const u = Math.max(0, Math.min(1, (s - this.L[i - 1]) / ((this.L[i] - this.L[i - 1]) || 1)));
    return { x: this.path[i - 1].x + (this.path[i].x - this.path[i - 1].x) * u, z: this.path[i - 1].z + (this.path[i].z - this.path[i - 1].z) * u };
  }
  /** Smallest turning radius over the next previewDistance (three-point circumradius every metre). */
  private radiusAhead(s: number): number {
    let r = Infinity;
    for (let d = 0; d < this.params.previewDistance; d += 1) {
      const a = this.at(s + d), b = this.at(s + d + 1), c = this.at(s + d + 2);
      const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ca = Math.hypot(a.x - c.x, a.z - c.z);
      const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      if (area2 > 1e-9) r = Math.min(r, (ab * bc * ca) / (2 * area2));
    }
    return r;
  }
  input(state: Readonly<DrivingState>): Readonly<DrivingInputState> {
    const p = this.params; const s = this.progress(state);
    const look = Math.max(p.minLookahead, Math.min(p.maxLookahead, p.minLookahead + p.lookaheadPerSpeed * Math.abs(state.speed)));
    const target = this.at(s + look);
    const want = Math.atan2(target.z - state.z, target.x - state.x);
    const err = Math.atan2(Math.sin(want - state.heading), Math.cos(want - state.heading));
    const limit = Math.max(p.minSpeed, Math.min(this.cruise, Math.sqrt(p.lateralAccel * this.radiusAhead(s))));
    const speedTarget = Math.abs(err) > p.slowError ? p.minSpeed : limit;
    return Object.freeze({ forward: state.speed < speedTarget - 0.05, backward: state.speed > speedTarget + 0.6, left: err < -p.deadband, right: err > p.deadband });
  }
}
export const routePilotFactory = (params: RoutePilotParams = DEFAULT_ROUTE_PILOT_PARAMS) => (path: readonly P[], cruise: number): RoutePilot => new CurvatureRoutePilot(path, cruise, params);
