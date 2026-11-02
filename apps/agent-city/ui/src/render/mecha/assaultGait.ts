export type GaitPoint = { x: number; y: number; z: number };
export type GaitStage =
  | { kind: "turn"; at: GaitPoint; yaw: number; delta: number; start: number; duration: number }
  | { kind: "transition"; at: GaitPoint; yaw: number; turnYaw: number; turnDelta: number; start: number; duration: number }
  | { kind: "walk"; from: GaitPoint; to: GaitPoint; yaw: number; cycles: number; start: number; duration: number };
export type GaitPlan = { stages: GaitStage[]; duration: number; end: GaitPoint; endYaw: number };
export type GaitSample =
  | { kind: "turn"; position: GaitPoint; yaw: number; delta: number; phase: number }
  | { kind: "transition"; position: GaitPoint; yaw: number; turnYaw: number; turnDelta: number; phase: number }
  | { kind: "walk"; position: GaitPoint; yaw: number; phase: number; stride: number }
  | { kind: "done"; position: GaitPoint; yaw: number; phase: 0 };

const angle = (value: number) => Math.atan2(Math.sin(value), Math.cos(value));
const finitePoint = (point: GaitPoint) => [point.x, point.y, point.z].every(Number.isFinite);

export function createAssaultGaitPlan(
  points: readonly GaitPoint[], initialYaw: number, stride: number, cycleSeconds: number, turnDuration: (delta: number) => number, transitionSeconds = 0,
): GaitPlan {
  if (!points.length || points.some((p) => !finitePoint(p)) || ![initialYaw, stride, cycleSeconds, transitionSeconds].every(Number.isFinite) || stride <= 0 || cycleSeconds <= 0 || transitionSeconds < 0) {
    throw new Error("invalid gait parameters");
  }
  const stages: GaitStage[] = [];
  let yaw = angle(initialYaw), elapsed = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!, to = points[i]!;
    const dx = to.x - from.x, dz = to.z - from.z, distance = Math.hypot(dx, dz);
    if (distance < 1e-8) {
      if (Math.abs(to.y - from.y) > 1e-8) throw new Error("vertical-only gait segment");
      continue;
    }
    const target = Math.atan2(-dx, -dz), delta = angle(target - yaw);
    if (Math.abs(delta) > 1e-8) {
      const duration = turnDuration(delta);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("invalid turn duration");
      stages.push({ kind: "turn", at: { ...from }, yaw, delta, start: elapsed, duration });
      elapsed += duration;
    }
    if (transitionSeconds > 0 && (Math.abs(delta) > 1e-8 || stages.length === 0)) {
      if (!Number.isFinite(elapsed + transitionSeconds)) throw new Error("gait route too long");
      stages.push({ kind: "transition", at: { ...from }, yaw: target, turnYaw: yaw, turnDelta: delta, start: elapsed, duration: transitionSeconds });
      elapsed += transitionSeconds;
    }
    const cycles = Math.ceil(distance / stride), duration = cycles * cycleSeconds;
    if (!Number.isSafeInteger(cycles) || !Number.isFinite(duration) || !Number.isFinite(elapsed + duration)) throw new Error("gait route too long");
    stages.push({ kind: "walk", from: { ...from }, to: { ...to }, yaw: target, cycles, start: elapsed, duration });
    elapsed += duration;
    yaw = target;
  }
  return { stages, duration: elapsed, end: { ...points[points.length - 1]! }, endYaw: yaw };
}

export function createStrideProfile(distances: readonly number[]): (phase: number) => number {
  if (distances.length < 2 || distances[0] !== 0 || !distances.every((value, i) => Number.isFinite(value) && value >= 0 && (i === 0 || value >= distances[i - 1]!))) throw new Error("invalid stride profile");
  const total = distances[distances.length - 1]!;
  if (total <= 0) throw new Error("empty stride profile");
  const profile = distances.map((value) => value / total);
  return (phase: number) => {
    if (!Number.isFinite(phase) || phase < 0 || phase > 1) throw new Error("invalid gait phase");
    const index = Math.min(profile.length - 2, Math.floor(phase * (profile.length - 1)));
    const alpha = phase * (profile.length - 1) - index;
    return profile[index]! + (profile[index + 1]! - profile[index]!) * alpha;
  };
}

export function sampleAssaultGait(plan: GaitPlan, seconds: number, strideProfile: (phase: number) => number): GaitSample {
  if (!Number.isFinite(seconds)) throw new Error("invalid gait time");
  const time = Math.max(0, seconds);
  const stage = plan.stages.find((entry) => time < entry.start + entry.duration);
  if (!stage) return { kind: "done", position: { ...plan.end }, yaw: plan.endYaw, phase: 0 };
  const progress = Math.max(0, Math.min(1, (time - stage.start) / stage.duration));
  if (stage.kind === "turn") return { kind: "turn", position: { ...stage.at }, yaw: stage.yaw, delta: stage.delta, phase: progress };
  if (stage.kind === "transition") return { kind: "transition", position: { ...stage.at }, yaw: stage.yaw, turnYaw: stage.turnYaw, turnDelta: stage.turnDelta, phase: progress };
  const cycle = progress * stage.cycles, whole = Math.floor(cycle), phase = cycle - whole;
  const fraction = strideProfile(phase);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error("invalid stride sample");
  const t = (whole + fraction) / stage.cycles;
  return { kind: "walk", position: { x: stage.from.x + (stage.to.x - stage.from.x) * t, y: stage.from.y + (stage.to.y - stage.from.y) * t, z: stage.from.z + (stage.to.z - stage.from.z) * t }, yaw: stage.yaw, phase, stride: Math.hypot(stage.to.x - stage.from.x, stage.to.z - stage.from.z) / stage.cycles };
}
