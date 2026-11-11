import type { MechaPerformanceEvent } from "./performance";
import { createAssaultGaitPlan, type GaitPlan, type GaitPoint } from "./assaultGait";

type Cell = { x: number; y: number };
type Turn = { yaw: number; delta: number; duration: number };
export type AssaultPerformanceEntry = {
  event: MechaPerformanceEvent;
  start: number;
  duration: number;
  endYaw: number;
  gait?: GaitPlan;
  attackTurn?: Turn;
};
export type AssaultPerformancePlan = { entries: AssaultPerformanceEntry[]; duration: number; endYaw: number };

const angle = (value: number) => Math.atan2(Math.sin(value), Math.cos(value));

export function createAssaultPerformancePlan(
  events: readonly MechaPerformanceEvent[], actor: string, initialYaw: number,
  cellToWorld: (cell: Cell, actor: string) => GaitPoint,
  stride: number, cycleSeconds: number, turnDuration: (delta: number) => number, transitionSeconds = 0,
): AssaultPerformancePlan {
  if (!actor || !Number.isFinite(initialYaw) || !Number.isFinite(transitionSeconds) || transitionSeconds < 0) throw new Error("invalid Assault performance actor or heading");
  const entries: AssaultPerformanceEntry[] = [];
  let elapsed = 0, yaw = angle(initialYaw);
  for (const event of events) {
    if (!Number.isFinite(event.duration) || event.duration <= 0) throw new Error("invalid performance duration");
    const entry: AssaultPerformanceEntry = { event, start: elapsed, duration: event.duration, endYaw: yaw };
    if (event.actor === actor && event.kind === "move") {
      if (event.path.length < 2) throw new Error("invalid performance path");
      const plan = createAssaultGaitPlan(event.path.map((cell) => cellToWorld(cell, actor)), yaw, stride, cycleSeconds, turnDuration, transitionSeconds);
      if (plan.duration <= 0) throw new Error("empty performance path");
      entry.gait = plan;
      entry.duration = plan.duration;
      yaw = plan.endYaw;
    } else if (event.actor === actor && event.kind === "attack") {
      const from = cellToWorld(event.from, actor), target = cellToWorld(event.target, event.targetIds[0] ?? actor);
      if (![from.x, from.y, from.z, target.x, target.y, target.z].every(Number.isFinite)) throw new Error("invalid attack position");
      const dx = target.x - from.x, dz = target.z - from.z;
      if (Math.hypot(dx, dz) > 1e-8) {
        const targetYaw = Math.atan2(-dx, -dz), delta = angle(targetYaw - yaw);
        if (Math.abs(delta) > 1e-8) {
          const duration = turnDuration(delta);
          if (!Number.isFinite(duration) || duration <= 0) throw new Error("invalid attack turn duration");
          entry.attackTurn = { yaw, delta, duration };
          entry.duration += duration;
        }
        yaw = targetYaw;
      }
    } else if (event.actor === actor && event.kind === "knockback") {
      if (event.path.length < 2) throw new Error("invalid knockback path");
      const from = cellToWorld(event.path[event.path.length - 2]!, actor), to = cellToWorld(event.path[event.path.length - 1]!, actor);
      const dx = to.x - from.x, dz = to.z - from.z;
      if (![dx, dz].every(Number.isFinite)) throw new Error("invalid knockback position");
      // Passive displacement never turns the mech toward the destination.
    }
    entry.endYaw = yaw;
    elapsed += entry.duration;
    if (!Number.isFinite(elapsed)) throw new Error("performance timeline too long");
    entries.push(entry);
  }
  return { entries, duration: elapsed, endYaw: yaw };
}
