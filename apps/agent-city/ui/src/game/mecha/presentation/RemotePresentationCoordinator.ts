import { canonicalJson, type MatchSnapshot, type TurnResolved } from "../contracts/match";
import type { BattleScenePort, RemoteBattleState } from "./BattleScenePort";

type Snapshot = MatchSnapshot<RemoteBattleState>;
type Turn = TurnResolved<RemoteBattleState>;

/** Authoritative UI state may advance immediately; board input stays locked until
 * the scene has caught up. A replacement snapshot cancels stale playback. */
export class RemotePresentationCoordinator {
  private scene: BattleScenePort | null = null;
  private latest: Snapshot | null = null;
  private queue: Turn[] = [];
  private epoch = 0;
  private active = false;
  private disposed = false;

  private readonly onPlaying: (playing: boolean) => void;

  constructor(onPlaying: (playing: boolean) => void) { this.onPlaying = onPlaying; }

  attach(scene: BattleScenePort) {
    if (this.disposed) return;
    this.scene = scene;
    if (this.latest) scene.applySnapshot(this.latest);
  }

  detach(scene: BattleScenePort) {
    if (scene !== this.scene) return;
    this.epoch += 1;
    this.queue = [];
    this.active = false;
    this.scene = null;
    this.onPlaying(false);
  }

  snapshot(snapshot: Snapshot) {
    const old = this.latest;
    this.latest = snapshot;
    // A metadata-only refresh must not interrupt playback, but a corrected
    // same-revision board or arena is still authoritative and must replace it.
    if (old && old.matchId === snapshot.matchId && old.ruleset === snapshot.ruleset && old.revision === snapshot.revision
      && canonicalJson(old.state) === canonicalJson(snapshot.state) && canonicalJson(old.arena) === canonicalJson(snapshot.arena)) return;
    this.epoch += 1;
    this.queue = [];
    this.active = false;
    this.scene?.applySnapshot(snapshot);
    this.onPlaying(false);
  }

  turn(turn: Turn, snapshot: Snapshot) {
    this.latest = snapshot;
    if (!this.scene) return; // attaching later applies the latest authoritative snapshot
    this.queue.push(turn);
    if (!this.active) void this.drain();
  }

  isPlaying() { return this.active; }

  dispose() {
    this.disposed = true;
    this.epoch += 1;
    this.queue = [];
    this.active = false;
    this.scene = null;
  }

  private async drain() {
    const epoch = this.epoch;
    const scene = this.scene!;
    this.active = true;
    this.onPlaying(true);
    try {
      while (this.queue.length && epoch === this.epoch && !this.disposed) {
        await scene.playTurn(this.queue.shift()!);
      }
    } catch {
      if (epoch === this.epoch) {
        if (this.latest) scene.applySnapshot(this.latest);
        this.queue = [];
      }
    } finally {
      if (epoch === this.epoch && !this.disposed) {
        this.active = false;
        this.onPlaying(false);
      }
    }
  }
}
