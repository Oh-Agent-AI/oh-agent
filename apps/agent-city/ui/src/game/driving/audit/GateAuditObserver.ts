import { freezeAuditCase } from "./AuditIdentity";
import { DRIVING_FOOTPRINT } from "../vehicleFootprint";
import type { DrivingState } from "../../DrivingSimulation";
import type { KernelStep } from "../DrivingKernel";
import type { AuditObserver, AuditWorldValidator, Observation, RoadAuditCase, StepValidation } from "./contracts";

/** A pilot cannot complete its own route. This observer requires an independent
 * world validator AND ordered, directional full-body gate crossings. */
export class GateAuditObserver implements AuditObserver {
  private nextGate = 0;
  private readonly test: RoadAuditCase;
  constructor(test: RoadAuditCase, private readonly world: AuditWorldValidator) {
    this.test = freezeAuditCase(test);
  }
  begin(state: Readonly<DrivingState>): StepValidation {
    return this.world.validateStart(state);
  }
  observe(previous: Readonly<DrivingState>, next: KernelStep): Observation {
    const validation = this.test.corridor.surfaceSequence.includes(next.state.surfaceId)
      ? this.world.validate(previous, next) : "route-deviation";
    const progress = this.world.progress(next.state);
    if (!Number.isFinite(progress)) return { status: "simulation-invalid", progress: 0, plannedStop: false };
    if (validation !== "valid") return { status: validation, progress, plannedStop: false };
    // Gates are crossed along the motion actually performed. A continuous (C) step reports its piecewise
    // trajectory (tangent slides make it a polyline); judging its end-to-end chord would accept a gate the
    // car never crossed, or miss one it crossed and slid back from. Without a trajectory the step is the
    // single segment previous → next, exactly as before (compatibility for whole-step environments).
    const path = next.motion.trajectory && next.motion.trajectory.length >= 1
      ? [previous, ...next.motion.trajectory.slice(1)] : [previous, next.state];
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1]; const b = path[k];
      while (this.nextGate < this.test.gates.length) {
        const gate = this.test.gates[this.nextGate];
        const extent = (heading: number) => DRIVING_FOOTPRINT.halfLength * Math.abs(Math.cos(heading) * gate.forwardX + Math.sin(heading) * gate.forwardZ) +
          DRIVING_FOOTPRINT.halfWidth * Math.abs(-Math.sin(heading) * gate.forwardX + Math.cos(heading) * gate.forwardZ);
        const plane = (state: Readonly<{ x: number; z: number; heading: number }>) => (state.x - gate.x) * gate.forwardX + (state.z - gate.z) * gate.forwardZ - extent(state.heading);
        const before = plane(a); const after = plane(b);
        if (!(before <= 0 && after > 0)) break;
        const t = -before / (after - before);
        const heading = a.heading + (b.heading - a.heading) * t;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const lateral = Math.abs(-(x - gate.x) * gate.forwardZ + (z - gate.z) * gate.forwardX);
        const halfWidth = DRIVING_FOOTPRINT.halfLength * Math.abs(-Math.cos(heading) * gate.forwardZ + Math.sin(heading) * gate.forwardX) +
          DRIVING_FOOTPRINT.halfWidth * Math.abs(Math.sin(heading) * gate.forwardZ + Math.cos(heading) * gate.forwardX);
        // 门是一条无限长的平面：长路线（出生 → 最远节点）会在别处横穿自己出口门的延长线（0/7 实测：离门 517），
        // 那不是这道门，不计也不判偏离。离门近处的真偏离由走廊校验先报。
        if (lateral > 2 * gate.halfWidth + 2 * DRIVING_FOOTPRINT.halfLength) break;
        const y = a.y + (b.y - a.y) * t;
        if (lateral + halfWidth > gate.halfWidth || Math.abs(y - gate.y) > gate.heightTolerance || !gate.surfaceIds.includes(b.surfaceId)) {
          return { status: "route-deviation", progress, plannedStop: false };
        }
        this.nextGate++;
      }
    }
    return { status: this.nextGate === this.test.gates.length ? "complete" : "continue", progress, plannedStop: false };
  }
}
