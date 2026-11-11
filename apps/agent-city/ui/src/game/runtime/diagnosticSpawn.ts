/** Bounded UAT-only placement search. These points are diagnostic, never released
 * graph evidence or confirmed product spawns. All poses use the session's frozen
 * surface and full collision environment, including the complete car footprint. */
import type { CompiledCitySurface } from "../../engine/surface/types";
import type { SurfaceRegionsBuild } from "../../engine/surface/surfaceRegions";
import { initialDrivingState, type DrivingState, type DrivingMotion, type DrivingMoveResult } from "../DrivingSimulation";
import type { DrivingEnvironment } from "../DrivingSimulation";
import { preparationCheckpoint, preparationNow } from "./Preparation";

type SpawnEnvironment = Pick<DrivingEnvironment, "move"> & Readonly<{
  place(x: number, z: number, heading: number, regionId: string, y?: number): Readonly<{ y: number; pitch: number; roll: number }> | null;
  moveAsync?(start: DrivingState, desired: DrivingMotion, checkpoint: () => Promise<void>): Promise<DrivingMoveResult>;
}>;
type SpawnStep = Readonly<{ kind: "candidate" }> | Readonly<{ kind: "move"; start: DrivingState; desired: DrivingMotion }>;

// A short 2.5-unit probe accepts intersection noses between splitter islands.
// Require a useful run-up both ways so the diagnostic car starts somewhere it
// can actually pull away from, not merely somewhere its stationary body fits.
const SPAWN_PROBE_DISTANCE = 6;
const DIAGNOSTIC_SPAWN_CANDIDATE_LIMIT = 512;

type Near = Readonly<{ x: number; z: number }>;
const patchCentre = (v: ArrayLike<number>) => { let x = 0, z = 0; const n = v.length / 3; for (let i = 0; i < v.length; i += 3) { x += v[i]; z += v[i + 2]; } return { x: x / n, z: z / n }; };

function* diagnosticSpawnSteps(surface: CompiledCitySurface, regions: Extract<SurfaceRegionsBuild, { status: "ready" }>,
  environment: SpawnEnvironment, near?: Near): Generator<SpawnStep, DrivingState | null, DrivingMoveResult | undefined> {
  let budget = DIAGNOSTIC_SPAWN_CANDIDATE_LIMIT;
  let forwardOnly: DrivingState | null = null;

  function* hasShortClearance(start: DrivingState, direction: "forward" | "backward"): Generator<SpawnStep, boolean, DrivingMoveResult | undefined> {
    const sign = direction === "forward" ? 1 : -1;
    const desired = { x: start.x + Math.cos(start.heading) * SPAWN_PROBE_DISTANCE * sign,
      z: start.z + Math.sin(start.heading) * SPAWN_PROBE_DISTANCE * sign, heading: start.heading,
      travelBudget: SPAWN_PROBE_DISTANCE };
    const moved = yield { kind: "move", start, desired };
    if (!moved) throw new Error("missing-spawn-probe-result");
    return !moved.blocked && Math.hypot(moved.x - start.x, moved.z - start.z) >= SPAWN_PROBE_DISTANCE * 0.95;
  }

  const tryPose = (x: number, z: number, heading: number, layerId: string): DrivingState | null => {
    if (budget <= 0) return null;
    budget -= 1;
    const point = regions.classify(x, z, layerId);
    if (point.status !== "drivable") return null;
    const support = environment.place(x, z, heading, point.regionId);
    if (!support) return null;
    return { ...initialDrivingState(x, z, heading, point.regionId), ...support };
  };

  // Ground carriageways first. The longest axis of a road mesh gives a more
  // reliable tangent than the farthest vertex from its bounding-box midpoint.
  // near（从地标停车场出发）：先试离出发点最近的路面——候选与校验一条不少，只是顺序换成由近到远，
  // 512 个候选的预算先花在地标门口，而不是全城第一块路面上（那样车会出生在城另一头）。
  const ordered = near ? surface.patches.filter((p) => p.kind === "carriageway" && p.vertices.length >= 9)
    .map((patch) => { const c = patchCentre(patch.vertices); return { patch, d: Math.hypot(c.x - near.x, c.z - near.z) }; })
    .sort((a, b) => a.d - b.d).map((item) => item.patch) : surface.patches;
  for (const patch of ordered) {
    if (patch.kind !== "carriageway") continue;
    const v = patch.vertices;
    if (v.length < 9) continue;
    let meanX = 0, meanZ = 0;
    const count = v.length / 3;
    for (let i = 0; i < v.length; i += 3) { meanX += v[i]; meanZ += v[i + 2]; }
    meanX /= count; meanZ /= count;

    let xx = 0, zz = 0, xz = 0;
    let minAlong = Infinity, maxAlong = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      const dx = v[i] - meanX, dz = v[i + 2] - meanZ;
      xx += dx * dx; zz += dz * dz; xz += dx * dz;
    }
    const heading = 0.5 * Math.atan2(2 * xz, xx - zz);
    const axisX = Math.cos(heading), axisZ = Math.sin(heading);
    for (let i = 0; i < v.length; i += 3) {
      const along = (v[i] - meanX) * axisX + (v[i + 2] - meanZ) * axisZ;
      minAlong = Math.min(minAlong, along); maxAlong = Math.max(maxAlong, along);
    }

    // Test several points along long strips. Static placement checks the full
    // body; continuous 2.5-unit sweeps verify support and collision both ways.
    const spans = maxAlong - minAlong;
    const positions: ReadonlyArray<readonly [number, number]> = [[meanX, meanZ], ...[0, 0.3, -0.3].map((fraction) => {
      const along = (minAlong + maxAlong) * 0.5 + spans * fraction;
      return [meanX + axisX * along, meanZ + axisZ * along] as const;
    })];
    for (const [x, z] of positions) {
      for (const angle of [heading, heading + Math.PI]) {
        if (budget <= 0) return forwardOnly;
        yield { kind: "candidate" };
        const state = tryPose(x, z, angle, patch.layerId);
        if (!state) { if (budget <= 0) return forwardOnly; continue; }
        if (!(yield* hasShortClearance(state, "forward"))) continue;
        if (yield* hasShortClearance(state, "backward")) return state;
        if (!forwardOnly) forwardOnly = state;
      }
    }
    if (budget <= 0) return forwardOnly;
  }
  return forwardOnly;
}

/** Synchronous audit/fixture compatibility; identical candidate order and checks. */
export function diagnosticSpawn(surface: CompiledCitySurface, regions: Extract<SurfaceRegionsBuild, { status: "ready" }>,
  environment: SpawnEnvironment, near?: Near): DrivingState | null {
  const steps = diagnosticSpawnSteps(surface, regions, environment, near);
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    next = steps.next(step.kind === "move" ? environment.move(step.start, step.desired) : undefined);
  }
  return next.value;
}

/** Real interactive entry yields between candidates without changing the search. */
export async function diagnosticSpawnAsync(surface: CompiledCitySurface, regions: Extract<SurfaceRegionsBuild, { status: "ready" }>,
  environment: SpawnEnvironment, signal?: AbortSignal, isCurrent: () => boolean = () => true,
  onCandidateProgress?: (completedCandidates: number, candidateLimit: number) => void, near?: Near): Promise<DrivingState | null> {
  const steps = diagnosticSpawnSteps(surface, regions, environment, near);
  let completedCandidates = 0;
  let deadline = preparationNow() + 8;
  const checkpoint = async () => {
    if (signal?.aborted) throw new Error("cancelled");
    if (!isCurrent()) throw new Error("stale-game-world");
    if (preparationNow() >= deadline) {
      await preparationCheckpoint(signal, isCurrent);
      deadline = preparationNow() + 8;
    }
  };
  let next = steps.next();
  while (!next.done) {
    await checkpoint();
    const step = next.value;
    if (step.kind === "candidate") {
      // Resume the generator first: that is when it actually classifies and
      // validates this candidate. Reporting before resumption counted a pose
      // the search had not examined yet (and could report one past its budget).
      next = steps.next();
      completedCandidates++;
      if (completedCandidates % 8 === 0) reportProgress();
      continue;
    }
    const moved = environment.moveAsync
      ? await environment.moveAsync(step.start, step.desired, checkpoint)
      : environment.move(step.start, step.desired);
    next = steps.next(moved);
  }
  if (completedCandidates % 8 !== 0) reportProgress();
  return next.value;

  function reportProgress() {
    try { onCandidateProgress?.(completedCandidates, DIAGNOSTIC_SPAWN_CANDIDATE_LIMIT); } catch { /* progress is observational only */ }
  }
}
