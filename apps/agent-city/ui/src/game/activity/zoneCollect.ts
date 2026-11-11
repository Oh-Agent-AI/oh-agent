import type { CityGameMountV1, MiniGamePackV1, Result, DiagnosticV1 } from "@agent-vitals/city-sdk";
import { selectCheckpointRaceCourse, type CityLayoutSdkViewV1 } from "../../engine/sdk/cityLayoutAdapter";
import { toMeters } from "../../engine/worldScale";
import { createMountedMiniGamePlan, MountedMiniGameControllerV1, type MountedMiniGamePlanV1 } from "./mountedMiniGame";
import type { CheckpointRaceSnapshotV1 } from "./checkpointRace";

const TARGET_COUNT = 3;
export type ZoneCollectPlanV1 = Readonly<{
  course: ReturnType<typeof selectCheckpointRaceCourse> & {};
  pack: MiniGamePackV1;
  mount: CityGameMountV1;
  mounted: MountedMiniGamePlanV1;
  checkpointGeometry: readonly Readonly<{ x: number; y: number; z: number; radius: number; facingRadians: number }>[];
}>;

const diagnostic = (code: string, message: string): DiagnosticV1 => ({ code, severity: "error", path: "layout.roadSegments", message });

export function createZoneCollectPlan(view: CityLayoutSdkViewV1): Result<ZoneCollectPlanV1> {
  const course = selectCheckpointRaceCourse(view, TARGET_COUNT);
  if (!course) return { ok: false, diagnostics: [diagnostic("collect_route_unavailable", "当前道路网络无法生成寻宝路线。" )] };
  const checkpointGeometry = course.checkpointAnchorIds.map(id => {
    const anchor = view.layout.anchors.find(value => value.id === id);
    const geometry = anchor ? view.geometry.get(anchor.geometryRef) : null;
    return geometry?.activationRadiusMeters !== undefined && geometry.facingRadians !== undefined
      ? { x: geometry.positionMeters.x, y: geometry.positionMeters.y, z: geometry.positionMeters.z, radius: geometry.activationRadiusMeters, facingRadians: geometry.facingRadians }
      : null;
  });
  if (checkpointGeometry.some(value => value === null)) return { ok: false, diagnostics: [diagnostic("collect_geometry_unavailable", "寻宝目标缺少可信空间几何。" )] };
  const pack: MiniGamePackV1 = {
    schemaVersion: 1, id: "official-zone-collect-v1", rulesVersion: 1,
    slots: { targets: { kind: "zone", min: TARGET_COUNT, max: TARGET_COUNT, requires: ["drive"] } },
    rules: { counters: { found: { initial: 0, max: TARGET_COUNT } }, nodes: [
      ...Array.from({ length: TARGET_COUNT }, (_, index) => ({ id: `collect-${index + 1}`, on: { type: "zone.entered" as const, slot: "targets" }, when: [{ op: "counter.eqEventIndex" as const, counter: "found" }], actions: [{ op: "counter.add" as const, counter: "found", amount: 1 }] })),
      { id: "all-found", on: { type: "zone.entered", slot: "targets" }, when: [{ op: "counter.eq", counter: "found", value: TARGET_COUNT }], actions: [{ op: "run.finish", outcome: "success" }] },
    ] },
  };
  const mount: CityGameMountV1 = {
    schemaVersion: 1, mountId: "official-zone-collect", layout: { kind: "city-layout", id: view.layout.id, version: "1", digest: view.worldRevision },
    game: { kind: "city-minigame", id: pack.id, version: "1", digest: "builtin:official-zone-collect-v1" },
    entryAnchorId: course.startAnchorId, bindings: { targets: [...course.checkpointAnchorIds] }, parameterOverrides: {},
  };
  const mounted = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(pack), mount, gameRef: mount.game, seed: view.seed });
  if (!mounted.ok) return { ok: false, diagnostics: mounted.diagnostics };
  return { ok: true, value: { course, pack, mount, mounted: mounted.value,
    checkpointGeometry: checkpointGeometry as NonNullable<(typeof checkpointGeometry)[number]>[] }, diagnostics: [] };
}

export class ZoneCollectControllerV1 {
  private readonly activity: MountedMiniGameControllerV1;
  private snapshotValue: CheckpointRaceSnapshotV1 = Object.freeze({ status: "ready", completed: 0, total: TARGET_COUNT, elapsedSeconds: 0, reason: null });
  constructor(readonly plan: ZoneCollectPlanV1, private readonly onChange: (snapshot: CheckpointRaceSnapshotV1) => void) {
    this.activity = new MountedMiniGameControllerV1(plan.mounted, snapshot => {
      this.publish({ status: snapshot.status, completed: snapshot.state.counters.found ?? 0, total: TARGET_COUNT,
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
    this.snapshotValue = Object.freeze(snapshot); this.onChange(this.snapshotValue);
  }
}
