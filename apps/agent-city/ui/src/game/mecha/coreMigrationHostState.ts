import { matchesCoreMigrationVersion, nextCoreMigrationVersion, type CoreMigrationVersion } from "./coreMigrationVersion";
import type { L9Ledger, L9Proposal } from "./skillCoreMigrationAdapter";
import type { MigrationEvent } from "./skillCoreMigration";

/** Host-owned durable values. This does not authenticate imported state. */
export type CoreMigrationHostState = {
  version: CoreMigrationVersion;
  ledger: L9Ledger;
  events: MigrationEvent[];
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Returns a new durable state only when the entire compare-and-swap succeeds. */
export function commitCoreMigrationHostState(current: CoreMigrationHostState, proposal: L9Proposal): CoreMigrationHostState | null {
  const expected = { matchId: proposal.matchId, revision: proposal.expectedRevision };
  const next = nextCoreMigrationVersion(current.version);
  if (!matchesCoreMigrationVersion(current.version, expected) || !next || proposal.nextRevision !== next.revision ||
      !current.ledger.pending || canonical(current.ledger.pending) !== canonical(proposal.expectedPending)) return null;
  return { version: next, ledger: structuredClone(proposal.nextLedger), events: [...structuredClone(current.events), ...structuredClone(proposal.events)] };
}
