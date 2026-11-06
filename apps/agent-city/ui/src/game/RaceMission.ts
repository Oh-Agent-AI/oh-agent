/**
 * RaceMission（§7.2）：穿环任务纯逻辑——倒计时、连续穿环检测（前后位置跨环面、
 * 指定方向、扣除安全半径的圆内交点）、错误顺序不计、同一步多环按交点时间排序、
 * 重置瞬移不参与检测、碰撞罚时（3s + 1s 保护窗）、终态只结算一次、
 * 最后一环与超时同一步时按步内交点时刻与截止比较。不依赖 three/DOM/React。
 */
import type { CourseRing, RaceCourse } from "./RaceCourse";
import type { FlightParams } from "./FlightSimulation";

export const COUNTDOWN_MS = 3000;
export const COLLISION_PENALTY_MS = 3000;
export const COLLISION_PROTECTION_MS = 1000;

export type RaceStatus = "countdown" | "racing" | "finished" | "failed";

export type RaceResult = {
  finished: boolean;
  /** 模拟耗时（不含罚时）。 */
  elapsedMs: number;
  collisions: number;
  penaltyMs: number;
  /** 最终用时 = 模拟耗时 + 罚时。 */
  finalMs: number;
};

export type RaceStepEvent =
  | { type: "countdown-tick"; remainingMs: number }
  | { type: "countdown-done" }
  | { type: "ring-passed"; index: number; progress: number }
  | { type: "penalty"; totalPenaltyMs: number }
  | { type: "finished"; result: RaceResult }
  | { type: "failed"; result: RaceResult };

export type RaceMissionSnapshot = {
  status: RaceStatus;
  targetIndex: number;
  progress: number;
  total: number;
  elapsedMs: number;
  remainingMs: number;
  penaltyMs: number;
  collisions: number;
  countdownRemainingMs: number;
  result: RaceResult | null;
};

type Vec3 = { x: number; y: number; z: number };

export class RaceMission {
  private status: RaceStatus = "countdown";
  private countdownRemainingMs = COUNTDOWN_MS;
  private elapsedMs = 0;
  private penaltyMs = 0;
  private collisions = 0;
  private targetIndex = 0;
  private progress = 0;
  private protectionRemainingMs = 0;
  private result: RaceResult | null = null;

  constructor(
    private readonly course: RaceCourse,
    private readonly params: FlightParams,
  ) {}

  snapshot(): RaceMissionSnapshot {
    return {
      status: this.status,
      targetIndex: this.targetIndex,
      progress: this.progress,
      total: this.course.rings.length,
      elapsedMs: this.elapsedMs,
      remainingMs: Math.max(0, this.course.timeLimitMs - (this.elapsedMs + this.penaltyMs)),
      penaltyMs: this.penaltyMs,
      collisions: this.collisions,
      countdownRemainingMs: Math.max(0, this.countdownRemainingMs),
      result: this.result,
    };
  }

  /** 倒计时推进（模拟时钟；调用方保证倒计时期间飞机位置冻结）。 */
  tickCountdown(dtMs: number): RaceStepEvent[] {
    if (this.status !== "countdown") return [];
    this.countdownRemainingMs -= dtMs;
    if (this.countdownRemainingMs > 0) return [{ type: "countdown-tick", remainingMs: this.countdownRemainingMs }];
    this.status = "racing";
    return [{ type: "countdown-done" }];
  }

  /**
   * 一个物理步：推进任务时钟并做穿环/超时判定。
   * teleport=true（碰撞温和重置产生的瞬移）不参与穿环检测（§7.2）。
   */
  step(prev: Vec3, next: Vec3, dtMs: number, teleport = false): RaceStepEvent[] {
    if (this.status !== "racing") return [];
    this.protectionRemainingMs = Math.max(0, this.protectionRemainingMs - dtMs);
    const events: RaceStepEvent[] = [];
    if (!teleport) {
      // 同一步可能跨多个相邻环：按交点时间升序处理（帧率无关）。
      for (let guard = 0; guard < this.course.rings.length; guard += 1) {
        // 2026-10-09：安全半径减半（planeRadius * 0.5）——全值时环半径 8.2 减 2.4
        // 只剩 5.8 有效区，视觉上穿了环但判定说擦边不算。
        const crossing = ringCrossing(this.course.rings[this.targetIndex], prev, next, this.params.planeRadius * 0.5);
        if (!crossing) break;
        this.progress += 1;
        events.push({ type: "ring-passed", index: this.targetIndex, progress: this.progress });
        if (this.targetIndex === this.course.rings.length - 1) {
          // 最后一环：按步内交点时刻与截止比较（截止时刻及之前完成算成功）。
          const elapsedAtCross = this.elapsedMs + crossing.t * dtMs;
          const finalMs = elapsedAtCross + this.penaltyMs;
          if (finalMs <= this.course.timeLimitMs) {
            this.settle(true, elapsedAtCross);
            events.push({ type: "finished", result: this.result! });
            return events;
          }
          this.settle(false, this.elapsedMs + dtMs);
          events.push({ type: "failed", result: this.result! });
          return events;
        }
        this.targetIndex += 1;
      }
    }
    this.elapsedMs += dtMs;
    if (this.elapsedMs + this.penaltyMs >= this.course.timeLimitMs) {
      this.settle(false, this.elapsedMs);
      events.push({ type: "failed", result: this.result! });
    }
    return events;
  }

  /** 碰撞罚时：保护窗内不重复扣罚（§6.3）；保护期不跳环、不穿模由模拟层保证。 */
  onCollision(): RaceStepEvent[] {
    if (this.status !== "racing" || this.protectionRemainingMs > 0) return [];
    this.protectionRemainingMs = COLLISION_PROTECTION_MS;
    this.penaltyMs += COLLISION_PENALTY_MS;
    this.collisions += 1;
    const events: RaceStepEvent[] = [{ type: "penalty", totalPenaltyMs: this.penaltyMs }];
    if (this.elapsedMs + this.penaltyMs >= this.course.timeLimitMs) {
      this.settle(false, this.elapsedMs);
      events.push({ type: "failed", result: this.result! });
    }
    return events;
  }

  /** 提前放弃（退出/错误面板）：不结算成功成绩。 */
  abort(): void {
    if (this.status === "countdown" || this.status === "racing") this.status = "failed";
  }

  private settle(finished: boolean, elapsedMs: number): void {
    if (this.result) return; // 终态只结算一次
    this.status = finished ? "finished" : "failed";
    this.result = { finished, elapsedMs: Math.round(elapsedMs), collisions: this.collisions, penaltyMs: this.penaltyMs, finalMs: Math.round(elapsedMs + this.penaltyMs) };
  }
}

/**
 * 环面穿越检测：prev→next 按指定方向（法线正向）跨过环面，交点在扣除飞机安全
 * 半径的圆内。返回交点参数 t∈(0,1]；未过/反向/擦边/圆外返回 null。
 */
export function ringCrossing(ring: CourseRing, prev: Vec3, next: Vec3, planeSafeRadius: number): { t: number } | null {
  const s0 = (prev.x - ring.x) * ring.nx + (prev.y - ring.y) * ring.ny + (prev.z - ring.z) * ring.nz;
  const s1 = (next.x - ring.x) * ring.nx + (next.y - ring.y) * ring.ny + (next.z - ring.z) * ring.nz;
  if (!(s0 < 0) || !(s1 >= 0)) return null; // 必须从背面到正面（指定方向）
  const t = s0 / (s0 - s1);
  if (!Number.isFinite(t) || t <= 0 || t > 1) return null;
  const x = prev.x + (next.x - prev.x) * t;
  const y = prev.y + (next.y - prev.y) * t;
  const z = prev.z + (next.z - prev.z) * t;
  const radial = Math.hypot(x - ring.x, y - ring.y, z - ring.z);
  if (radial > ring.radius - planeSafeRadius) return null; // 掠过外圈不算
  return { t };
}
