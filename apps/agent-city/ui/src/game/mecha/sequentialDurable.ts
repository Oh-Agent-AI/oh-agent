/** Write-ahead coordinator for a single local v1.5 authority.
 * The injected store must atomically compare the expected revision and commit
 * the full verified history. A failed acknowledgement is ambiguous and freezes
 * this instance until it is reconstructed from the store. */
import type { MatchState } from "./board";
import { SequentialTurn, type SequentialCommand, type SequentialRecord, type SequentialResult } from "./sequentialTurn";
import { enemyPlannerFor } from "./enemy/policy";
import type { EnemyPolicy } from "./enemy/contracts";

export type SequentialDurableStore = {
  commit(expectedRevision: number, records: readonly SequentialRecord[]): Promise<void>;
};
export type DurableResult = SequentialResult | { ok: false; reason: "busy" | "storage_unconfirmed" };

export class SequentialDurableAuthority {
  private readonly initial: MatchState;
  private session: SequentialTurn;
  private readonly store: SequentialDurableStore;
  private readonly enemyPolicy: EnemyPolicy;
  private busy = false;
  private uncertain = false;
  constructor(initial: MatchState, records: readonly SequentialRecord[], store: SequentialDurableStore, enemyPolicy: EnemyPolicy = "baup") {
    this.initial = structuredClone(initial);
    this.session = SequentialTurn.replay(this.initial, records, { enemyPlanner: enemyPlannerFor(enemyPolicy) });
    this.store = store;
    this.enemyPolicy = enemyPolicy;
  }
  snapshot() { return this.session.snapshot(); }
  records() { return this.session.records(); }
  recordCount() { return this.session.recordCount(); }
  needsReload() { return this.uncertain; }
  invalidate() { this.uncertain = true; }
  async execute(command: SequentialCommand): Promise<DurableResult> {
    if (this.uncertain) return { ok: false, reason: "storage_unconfirmed" };
    if (this.busy) return { ok: false, reason: "busy" };
    this.busy = true;
    try {
      const old = this.session.snapshot(), records = this.session.records();
      const candidate = SequentialTurn.replay(this.initial, records, { enemyPlanner: enemyPlannerFor(this.enemyPolicy) });
      const result = candidate.execute(command);
      if (!result.ok) return result;
      const next = candidate.records();
      // A successful retry is already durable; never write the same command twice.
      if (next.length === records.length) return result;
      try { await this.store.commit(old.match.revision, next); }
      catch { this.uncertain = true; return { ok: false, reason: "storage_unconfirmed" }; }
      this.session = candidate;
      return result;
    } finally { this.busy = false; }
  }
}
