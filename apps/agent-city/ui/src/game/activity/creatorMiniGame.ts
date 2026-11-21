import type { CityGameMountV1, MiniGamePackV1, ContentRef, VisualPlaytestEvidenceV1, SceneDraftV1, CityProjectAssetCatalogV1, ModelAssetRefV1, CitySkinPackIdV1 } from "@oh-agent/city-sdk";
import { toMeters } from "../../engine/worldScale";
import type { CheckpointRaceSnapshotV1 } from "./checkpointRace";
import { createMountedMiniGamePlan, MountedMiniGameControllerV1, type MountedMiniGameCapability, type MountedMiniGamePlanV1, type MountedMiniGameSnapshotV1 } from "./mountedMiniGame";
import type { CityLayoutSdkViewV1 } from "../../engine/sdk/cityLayoutAdapter";

export type CreatorPublishedMiniGameV1 = Readonly<{
  releaseId: string;
  title: string;
  skinId?: CitySkinPackIdV1;
  game: MiniGamePackV1;
  mount: CityGameMountV1;
  scenePackage?: Readonly<{ scene: SceneDraftV1; assets: CityProjectAssetCatalogV1; assetRefs: readonly ModelAssetRefV1[] }>;
  entryPositionWorld?: Readonly<{ x: number; z: number }>;
}>;

export function createCreatorMiniGamePlan(view: CityLayoutSdkViewV1, experience: CreatorPublishedMiniGameV1,
  options: Readonly<{ capability?: MountedMiniGameCapability }> = {}): ReturnType<typeof createMountedMiniGamePlan> {
  const capability = options.capability ?? "drive";
  const runtime = capability === "fly" ? "飞行" : "驾驶";
  const slots = Object.values(experience.game.slots);
  if (slots.some(slot => slot.kind !== "zone" || slot.requires?.some(required => required !== capability))) {
    return { ok: false, diagnostics: [{ code: "creator_game_capability_unsupported", severity: "error", path: "game.slots", message: `City ${runtime}运行时只支持 ${capability} 能力的 zone 槽位。` }] };
  }
  if (experience.game.rules.nodes.some(node => !["run.started", "zone.entered", "timer.expired"].includes(node.on.type))) {
    return { ok: false, diagnostics: [{ code: "creator_game_event_unsupported", severity: "error", path: "game.rules.nodes.on", message: `City ${runtime}运行时只会产生小游戏启动、区域进入和计时器事件。` }] };
  }
  return createMountedMiniGamePlan({ view, packageJson: JSON.stringify(experience.game), mount: experience.mount,
    gameRef: experience.mount.game as ContentRef<"city-minigame">, seed: view.seed, capability });
}

/** evidence JSON 长度护栏：宿主整份证据字节预算是 8 KiB（creator_playtest.rs 的
 * MAX_PLAYTEST_EVIDENCE_BYTES），超限证据会被 fail-closed 拒收并终止整个 finish 流程。
 * 这里按 7 KiB 收口，给宿主注记（evidenceSource/hostDisagreement）留余量；轨迹内容全
 * ASCII（slot 走 RULE_ID），JSON.stringify 长度即近似字节数。 */
const EVIDENCE_JSON_LENGTH_LIMIT = 7 * 1024;

/** Adapts the shared SDK runner to a City vehicle fixed-step path. It is the same
 * runner for driving and flying: the only per-capability choice is made when the
 * plan is created (which anchor capability the entry/slots need), not here. */
export class CreatorMiniGameRuntimeControllerV1 {
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
    const base: VisualPlaytestEvidenceV1 = { schemaVersion: 1, runtimeVersion: "city-mini-game-runtime-v1", releaseId, projectRevision,
      snapshotDigest, worldRevision: this.plan.mount.layout.digest, seed: this.plan.seed,
      game: Object.freeze({ id: this.plan.game.id, version: this.plan.mount.game.version, digest: this.plan.mount.game.digest }),
      tick: snapshot.state.tick, counters: Object.freeze({ ...snapshot.state.counters }), outcome: snapshot.state.outcome,
      reasonCode: snapshot.reason };
    // V3 S-6b：非空轨迹才附加可选第 13 键 trace（宿主对 12/13 两种键集都收；无事件时
    // 省略该键维持 12 键现状）。截断策略两层，均如实记录：
    // 1) runner 记录层（mountedMiniGame.ts）：FIFO 丢最旧保 64 条，与宿主 rule_replay 的
    //    MAX_REPLAY_EVENTS 对齐——被截掉的轨迹无法重放出截断前的计数器状态，宿主对这类
    //    终局会如实记 hostDisagreement（审计语义，不猜）。
    // 2) 本层字节护栏：超 7 KiB 时从最旧开始丢条目（余下仍保持追加序 → atTick 非降序），
    //    仍超限则整体省略 trace 退回 12 键 client-reported——绝不发送必被宿主拒绝的形状。
    const trace = this.controller.trace.map(entry => Object.freeze(entry));
    if (!trace.length) return Object.freeze(base);
    const withTrace = { ...base, trace: Object.freeze([...trace]) };
    if (JSON.stringify(withTrace).length <= EVIDENCE_JSON_LENGTH_LIMIT) return Object.freeze(withTrace);
    while (trace.length && JSON.stringify({ ...base, trace }).length > EVIDENCE_JSON_LENGTH_LIMIT) trace.shift();
    return trace.length ? Object.freeze({ ...base, trace: Object.freeze([...trace]) }) : Object.freeze(base);
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
