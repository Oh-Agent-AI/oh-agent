import { canonicalJson, type MatchEvent, type MatchResult, type MatchSnapshot, type TurnResolved } from "../contracts/match";
import { presentationSnapshot } from "../board";
import type { RemoteBattleState } from "../presentation/BattleScenePort";

type Snapshot = MatchSnapshot<RemoteBattleState>;
type Turn = TurnResolved<RemoteBattleState>;

type Callbacks = {
  snapshot: (snapshot: Snapshot, recovered: boolean) => void;
  turn: (turn: Turn, snapshot: Snapshot) => void;
  syncing: (value: boolean) => void;
  error: (message: string) => void;
};

/** Revision is a state version, not a turn counter: PvE may advance by three. */
function contiguous(current: Snapshot, turn: Turn): boolean {
  const diff = turn.revision - current.revision;
  if (diff < 1 || diff > 3) return false;
  if (turn.state.turn < current.state.turn || turn.state.turn > current.state.turn + 1) return false;
  return !turn.presentationStages || canonicalJson(turn.presentationStages.before) === canonicalJson(presentationSnapshot(current.state));
}

/** Buffers events during initial/reconnect snapshots and refuses ambiguous gaps.
 * A snapshot recovers state, not missing history. No protocol additions are made. */
export class RemoteMatchSynchronizer {
  private current: Snapshot | null = null;
  private buffered: Turn[] = [];
  private epoch = 0;
  private inFlight = false;
  private ready = false;
  private online = false;
  private closed = false;
  private disposed = false;
  private overflow = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private retryNeeded = false;

  private readonly matchId: string;
  private readonly fetchSnapshot: () => Promise<MatchResult<Snapshot>>;
  private readonly cb: Callbacks;

  constructor(matchId: string, fetchSnapshot: () => Promise<MatchResult<Snapshot>>, cb: Callbacks) {
    this.matchId = matchId;
    this.fetchSnapshot = fetchSnapshot;
    this.cb = cb;
  }

  connection(online: boolean) {
    const wasOnline = this.online;
    this.online = online;
    if (!online) {
      this.cancelRetry();
      if (wasOnline) {
        this.epoch += 1;
        this.inFlight = false;
      }
      this.ready = false;
      this.cb.syncing(true);
    } else if (!wasOnline && this.retryNeeded) this.scheduleRetry();
  }

  async resync() {
    if (this.disposed || this.closed) return;
    this.cancelRetry();
    const epoch = ++this.epoch;
    this.inFlight = true;
    this.ready = false;
    this.cb.syncing(true);
    try {
      const result = await this.fetchSnapshot();
      if (this.disposed || this.closed || epoch !== this.epoch) return;
      this.inFlight = false;
      if (!result.ok) { this.failed(result.error.code); return; }
      if (result.value.matchId !== this.matchId) { this.failed("invalid_message"); return; }
      this.acceptSnapshot(result.value);
    } catch {
      if (this.disposed || this.closed || epoch !== this.epoch) return;
      this.inFlight = false;
      this.failed("host_offline");
    }
  }

  event(event: MatchEvent<RemoteBattleState>) {
    if (this.disposed || this.closed) return;
    if (event.type === "match.closed") {
      if (event.matchId !== this.matchId || (this.current && event.revision < this.current.revision)) return;
      this.closed = true;
      this.cancelRetry();
      this.retryNeeded = false;
      this.epoch += 1;
      this.ready = false;
      this.cb.syncing(true);
      if (this.current) {
        this.current = { ...this.current, status: "closed" };
        this.cb.snapshot(this.current, false);
      }
      this.cb.error("room_closed");
    } else if (event.type === "match.replaced") {
      if (event.snapshot.matchId !== this.matchId) return;
      // Reconnect and host mode replacement supersede any older snapshot request.
      this.epoch += 1;
      this.inFlight = false;
      this.acceptSnapshot(event.snapshot);
    } else this.turn(event.result);
  }

  turn(turn: Turn) {
    if (this.disposed || this.closed || turn.matchId !== this.matchId) return;
    if (this.current && turn.state.ruleset === this.current.ruleset && turn.revision <= this.current.revision) return;
    if (!this.ready || this.inFlight || !this.current) { this.buffer(turn); return; }
    if (turn.state.ruleset !== this.current.ruleset || !contiguous(this.current, turn)) {
      this.buffer(turn);
      void this.resync();
      return;
    }
    this.applyTurn(turn);
  }

  canInteract() { return this.ready && this.online && !this.closed && !this.disposed; }

  dispose() { this.disposed = true; this.epoch += 1; this.cancelRetry(); this.buffered = []; }

  private failed(code: string) {
    this.retryNeeded = code === "host_offline" || code === "unavailable";
    if (!this.retryNeeded) this.retryDelay = 1000;
    this.cb.error(code);
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (!this.retryNeeded || !this.online || this.disposed || this.closed || this.inFlight || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, 15000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.resync();
    }, delay);
  }

  private cancelRetry() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private buffer(turn: Turn) {
    if (this.buffered.some((item) => item.revision === turn.revision && item.state.ruleset === turn.state.ruleset)) return;
    if (this.buffered.length >= 256) { this.buffered.shift(); this.overflow = true; }
    this.buffered.push(turn);
  }

  private acceptSnapshot(next: Snapshot) {
    if (next.matchId !== this.matchId || this.disposed || this.closed) return;
    this.cancelRetry();
    this.retryNeeded = false;
    this.retryDelay = 1000;
    const old = this.current;
    if (old && (next.mode !== old.mode || (old.mode === next.mode && next.revision < old.revision))) {
      next = old;
    }
    const recovered = Boolean(old && (this.overflow || (next.ruleset === old.ruleset && (next.revision > old.revision
      || (next.revision === old.revision && canonicalJson(next.state) !== canonicalJson(old.state))))));
    this.overflow = false;
    this.current = next;
    this.cb.snapshot(next, recovered);
    if (next.status === "closed") {
      this.closed = true;
      this.ready = false;
      this.cb.syncing(true);
      this.cb.error("room_closed");
      return;
    }
    this.ready = this.online;
    const pending = this.buffered;
    this.buffered = [];
    // A newer replacement makes events from the former ruleset irrelevant.
    pending.sort((a, b) => a.revision - b.revision);
    for (const turn of pending) {
      if (turn.state.ruleset !== next.ruleset) {
        if (next.mode === "pve") this.buffer(turn);
        continue;
      }
      if (turn.revision <= this.current!.revision) continue;
      if (!this.ready || !contiguous(this.current!, turn)) { this.buffer(turn); continue; }
      this.applyTurn(turn);
    }
    if (this.buffered.length) {
      this.ready = false;
      this.cb.syncing(true);
      this.cb.error("sync_incomplete");
    } else this.cb.syncing(!this.ready);
  }

  private applyTurn(turn: Turn) {
    const current = this.current!;
    const finished = turn.state.outcome;
    this.current = { ...current, revision: turn.revision, state: turn.state, status: finished ? "finished" : "active" };
    this.cb.turn(turn, this.current);
  }
}
