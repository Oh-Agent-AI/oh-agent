import type { MatchState } from "../board";
import type { DeployPlacement } from "../deployment";
import { enemyPlannerFor } from "../enemy/policy";
import type { EnemyPolicy } from "../enemy/contracts";
import { SequentialTurn, type SequentialCommand } from "../sequentialTurn";
import { SEQUENTIAL_NET_PROTOCOL, type SequentialCommandResult, type SequentialSnapshot, type SequentialSnapshotResult } from "../contracts/sequentialTransport";

/** Authoritative v1.5 command host. The snapshot is opening + accepted commands only. */
export class SequentialMatchSession {
  private readonly initial: MatchState;
  private readonly placements: DeployPlacement[];
  private readonly turn: SequentialTurn;
  readonly matchId: string;
  readonly enemyPolicy: EnemyPolicy;
  constructor(matchId: string, initial: MatchState, placements: readonly DeployPlacement[], commands: readonly SequentialCommand[] = [], enemyPolicy: EnemyPolicy = "baup") {
    this.enemyPolicy = enemyPolicy;
    this.matchId = matchId;
    this.initial = structuredClone(initial);
    this.placements = structuredClone([...placements]);
    this.turn = new SequentialTurn(this.initial, { enemyPlanner: enemyPlannerFor(this.enemyPolicy) });
    for (const command of commands) {
      const result = this.turn.execute(command);
      if (!result.ok) throw new Error(`invalid_sequential_session_seed:${result.reason}`);
    }
  }
  get revision(): number { return this.turn.snapshot().match.revision; }
  snapshot(): SequentialSnapshotResult {
    return { ok: true, snapshot: {
      protocol: SEQUENTIAL_NET_PROTOCOL, matchId: this.matchId, ruleset: "mecha-v1.5",
      revision: this.revision, enemyPolicy: this.enemyPolicy, initial: structuredClone(this.initial), placements: structuredClone(this.placements),
      commands: this.turn.records().map(record => record.command),
    } };
  }
  submit(baseRevision: number, command: SequentialCommand): SequentialCommandResult {
    if (baseRevision !== this.revision) return { ok: false, error: { code: "stale_revision" } };
    if (this.turn.snapshot().match.outcome) return { ok: false, error: { code: "match_finished" } };
    const result = this.turn.execute(command);
    if (!result.ok) {
      const code = result.reason === "duplicate_command" || result.reason === "stale_revision" ? result.reason : "invalid_command";
      return { ok: false, error: { code } };
    }
    const snapshot = this.snapshot();
    if (!snapshot.ok) return { ok: false, error: { code: "match_not_found" } };
    return { ok: true, snapshot: snapshot.snapshot, events: result.events, presentationStages: result.presentationStages };
  }
}

/** Rebuild and verify a received snapshot; any altered or truncated command fails. */
export function restoreSequentialSnapshot(snapshot: SequentialSnapshot): SequentialTurn {
  if (snapshot.protocol !== SEQUENTIAL_NET_PROTOCOL || snapshot.ruleset !== "mecha-v1.5" ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error("invalid_sequential_snapshot");
  const turn = new SequentialTurn(structuredClone(snapshot.initial), { enemyPlanner: enemyPlannerFor(snapshot.enemyPolicy ?? "scripted") });
  for (const command of snapshot.commands) {
    const result = turn.execute(command);
    if (!result.ok) throw new Error(`invalid_sequential_snapshot:${result.reason}`);
  }
  if (turn.snapshot().match.revision !== snapshot.revision) throw new Error("invalid_sequential_snapshot_revision");
  return turn;
}
