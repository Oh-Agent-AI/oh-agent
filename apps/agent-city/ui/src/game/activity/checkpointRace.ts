import { type CityGameMountV1, type MiniGamePackV1, type Result, type DiagnosticV1 } from "@agent-vitals/city-sdk";
import { selectCheckpointRaceCourse, type CityCheckpointRaceCourseV1, type CityLayoutSdkViewV1 } from "../../engine/sdk/cityLayoutAdapter";
import { toMeters } from "../../engine/worldScale";
import { createMountedMiniGamePlan, MountedMiniGameControllerV1, type MountedMiniGamePlanV1 } from "./mountedMiniGame";

const CHECKPOINT_COUNT = 3;
const RACE_TIME_LIMIT_TICKS = 2_700;

export type CheckpointRacePlanV1 = Readonly<{
  course: CityCheckpointRaceCourseV1;
  pack: MiniGamePackV1;
  mount: CityGameMountV1;
  mounted: MountedMiniGamePlanV1;
  seed: number;
  checkpointGeometry: readonly Readonly<{ x: number; y: number; z: number; radius: number; facingRadians: number }>[];
}>;
export type CheckpointRaceSnapshotV1 = Readonly<{
  status: "ready" | "running" | "success" | "failure" | "error";
  completed: number;
  total: number;
  elapsedSeconds: number;
  reason: string | null;
}>;

function diagnostic(code: string, path: string, message: string): DiagnosticV1 {
  return { code, severity: "error", path, message };
}

export function createCheckpointRacePlan(view: CityLayoutSdkViewV1, seed: number): Result<CheckpointRacePlanV1> {
  const course = selectCheckpointRaceCourse(view, CHECKPOINT_COUNT);
  if (!course) return { ok: false, diagnostics: [diagnostic("race_course_unavailable", "layout.roadSegments", "当前道路网络无法生成三检查点路线。") ] };
  const checkpointGeometry = course.checkpointAnchorIds.map(id => {
    const anchor = view.layout.anchors.find(value => value.id === id);
    const geometry = anchor ? view.geometry.get(anchor.geometryRef) : null;
    return geometry?.activationRadiusMeters !== undefined && geometry.facingRadians !== undefined
      ? { x: geometry.positionMeters.x, y: geometry.positionMeters.y, z: geometry.positionMeters.z, radius: geometry.activationRadiusMeters, facingRadians: geometry.facingRadians }
      : null;
  });
  if (checkpointGeometry.some(value => value === null)) return { ok: false, diagnostics: [diagnostic("race_geometry_unavailable", "layout.anchors", "当前检查点缺少可信空间几何。") ] };
  const pack: MiniGamePackV1 = {
    schemaVersion: 1,
    id: "official-checkpoint-race-v1",
    rulesVersion: 1,
    slots: { points: { kind: "zone", min: CHECKPOINT_COUNT, max: CHECKPOINT_COUNT, requires: ["drive"] } },
    integerParameters: { timeLimitTicks: { min: 600, max: 3600, default: RACE_TIME_LIMIT_TICKS } },
    rules: {
      counters: { next: { initial: 0, max: CHECKPOINT_COUNT } },
      nodes: [
        { id: "start-timer", on: { type: "run.started" }, actions: [{ op: "timer.start", timerId: "race-timeout", durationTicks: { parameter: "timeLimitTicks" } }] },
        { id: "advance-checkpoint", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
        { id: "finish-race", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eq", counter: "next", value: CHECKPOINT_COUNT }], actions: [{ op: "run.finish", outcome: "success" }] },
        { id: "time-expired", on: { type: "timer.expired", timerId: "race-timeout" }, actions: [{ op: "run.finish", outcome: "failure" }] },
      ],
    },
  };
  const mount: CityGameMountV1 = {
    schemaVersion: 1,
    mountId: "official-checkpoint-race",
    layout: { kind: "city-layout", id: view.layout.id, version: "1", digest: view.worldRevision },
    game: { kind: "city-minigame", id: pack.id, version: "1", digest: "builtin:official-checkpoint-race-v1" },
    entryAnchorId: course.startAnchorId,
    bindings: { points: [...course.checkpointAnchorIds] },
    parameterOverrides: { timeLimitTicks: RACE_TIME_LIMIT_TICKS },
  };
  const mounted = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(pack), mount, gameRef: mount.game, seed });
  if (!mounted.ok) return { ok: false, diagnostics: mounted.diagnostics };
  return { ok: true, value: { course, pack, mount, mounted: mounted.value, seed, checkpointGeometry: checkpointGeometry as NonNullable<(typeof checkpointGeometry)[number]>[] }, diagnostics: [] };
}

export class CheckpointRaceControllerV1 {
  private readonly activity: MountedMiniGameControllerV1;
  private snapshotValue: CheckpointRaceSnapshotV1 = Object.freeze({ status: "ready", completed: 0, total: CHECKPOINT_COUNT, elapsedSeconds: 0, reason: null });

  constructor(private readonly plan: CheckpointRacePlanV1, private readonly onChange: (snapshot: CheckpointRaceSnapshotV1) => void) {
    this.activity = new MountedMiniGameControllerV1(plan.mounted, snapshot => {
      this.publish({ status: snapshot.status, completed: snapshot.state.counters.next ?? 0, total: CHECKPOINT_COUNT,
        elapsedSeconds: Math.floor((snapshot.state.tick + 1) / 60), reason: snapshot.reason });
    });
  }

  get snapshot(): CheckpointRaceSnapshotV1 { return this.snapshotValue; }

  fixedStep(positionWorld: Readonly<{ x: number; y: number; z: number }>): void {
    this.activity.fixedStep({ x: toMeters(positionWorld.x), y: toMeters(positionWorld.y), z: toMeters(positionWorld.z) });
  }

  dispose(): void { this.activity.stop(); }

  private publish(snapshot: CheckpointRaceSnapshotV1): void {
    if (Object.keys(snapshot).every(key => snapshot[key as keyof CheckpointRaceSnapshotV1] === this.snapshotValue[key as keyof CheckpointRaceSnapshotV1])) return;
    this.snapshotValue = Object.freeze(snapshot);
    this.onChange(this.snapshotValue);
  }
}
