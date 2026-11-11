import type { CityGameMountV1, MiniGamePackV1, ContentRef, VisualPlaytestEvidenceV1, SceneDraftV1, CityProjectAssetCatalogV1, ModelAssetRefV1 } from "@agent-vitals/city-sdk";
import { toMeters } from "../../engine/worldScale";
import type { CheckpointRaceSnapshotV1 } from "./checkpointRace";
import { createMountedMiniGamePlan, MountedMiniGameControllerV1, type MountedMiniGamePlanV1, type MountedMiniGameSnapshotV1 } from "./mountedMiniGame";
import type { CityLayoutSdkViewV1 } from "../../engine/sdk/cityLayoutAdapter";

export type CreatorPublishedMiniGameV1 = Readonly<{
  releaseId: string;
  title: string;
  skinId?: "miami-vice" | "desert-evening";
  game: MiniGamePackV1;
  mount: CityGameMountV1;
  scenePackage?: Readonly<{ scene: SceneDraftV1; assets: CityProjectAssetCatalogV1; assetRefs: readonly ModelAssetRefV1[] }>;
  entryPositionWorld?: Readonly<{ x: number; z: number }>;
}>;

export function createCreatorMiniGamePlan(view: CityLayoutSdkViewV1, experience: CreatorPublishedMiniGameV1): ReturnType<typeof createMountedMiniGamePlan> {
  const slots = Object.values(experience.game.slots);
  if (slots.some(slot => slot.kind !== "zone" || slot.requires?.some(capability => capability !== "drive"))) {
    return { ok: false, diagnostics: [{ code: "creator_game_capability_unsupported", severity: "error", path: "game.slots", message: "City 驾驶运行时目前只支持 drive 能力的 zone 槽位。" }] };
  }
  if (experience.game.rules.nodes.some(node => !["run.started", "zone.entered", "timer.expired"].includes(node.on.type))) {
    return { ok: false, diagnostics: [{ code: "creator_game_event_unsupported", severity: "error", path: "game.rules.nodes.on", message: "City 驾驶运行时目前只会产生小游戏启动、区域进入和计时器事件。" }] };
  }
  return createMountedMiniGamePlan({ view, packageJson: JSON.stringify(experience.game), mount: experience.mount,
    gameRef: experience.mount.game as ContentRef<"city-minigame">, seed: view.seed });
}

/** Adapts the shared SDK runner to the existing City vehicle fixed-step path. */
export class CreatorMiniGameDrivingControllerV1 {
  private readonly controller: MountedMiniGameControllerV1;
  private snapshotValue: CheckpointRaceSnapshotV1;
  private readonly total: number;

  constructor(readonly plan: MountedMiniGamePlanV1, private readonly onChange: (snapshot: CheckpointRaceSnapshotV1) => void) {
    this.total = Object.values(plan.mount.bindings).reduce((count, anchors) => count + anchors.length, 0);
    this.snapshotValue = Object.freeze({ status: "ready", completed: 0, total: this.total, elapsedSeconds: 0, reason: null });
    this.controller = new MountedMiniGameControllerV1(plan, snapshot => this.publish(snapshot));
  }

  get snapshot(): CheckpointRaceSnapshotV1 { return this.snapshotValue; }

  visualEvidence(releaseId: string, projectRevision: number, snapshotDigest: string): VisualPlaytestEvidenceV1 {
    const snapshot = this.controller.snapshot;
    return Object.freeze({ schemaVersion: 1, runtimeVersion: "city-mini-game-runtime-v1", releaseId, projectRevision,
      snapshotDigest, worldRevision: this.plan.mount.layout.digest, seed: this.plan.seed,
      game: Object.freeze({ id: this.plan.game.id, version: this.plan.mount.game.version, digest: this.plan.mount.game.digest }),
      tick: snapshot.state.tick, counters: Object.freeze({ ...snapshot.state.counters }), outcome: snapshot.state.outcome,
      reasonCode: snapshot.reason });
  }

  fixedStep(positionWorld: Readonly<{ x: number; y: number; z: number }>): void {
    this.controller.fixedStep({ x: toMeters(positionWorld.x), y: toMeters(positionWorld.y), z: toMeters(positionWorld.z) });
  }

  dispose(): void { this.controller.stop(); }

  private publish(snapshot: MountedMiniGameSnapshotV1): void {
    const completed = Object.values(snapshot.state.counters).reduce((sum, value) => sum + value, 0);
    const next: CheckpointRaceSnapshotV1 = Object.freeze({ status: snapshot.status, completed: Math.min(this.total, completed), total: this.total,
      elapsedSeconds: Math.floor(snapshot.state.tick / 60), reason: snapshot.reason });
    this.snapshotValue = next;
    this.onChange(next);
  }
}
