/** Dedicated host revision: advance for every mutation of captured L9 state. */
export type CoreMigrationVersion = Readonly<{ matchId: string; revision: number }>;
const MAX_REVISION = 1_000_000;
export function nextCoreMigrationVersion(current: CoreMigrationVersion): CoreMigrationVersion | null {
  if (!/^[A-Za-z0-9_:-]{1,128}$/.test(current.matchId) ||
      !Number.isSafeInteger(current.revision) || Object.is(current.revision, -0) ||
      current.revision < 0 || current.revision >= MAX_REVISION) return null;
  return { matchId: current.matchId, revision: current.revision + 1 };
}
/** Reject proposals prepared against a different match or outdated revision. */
export function matchesCoreMigrationVersion(current: CoreMigrationVersion, expected: CoreMigrationVersion): boolean {
  return nextCoreMigrationVersion(current) !== null && current.matchId === expected.matchId && current.revision === expected.revision;
}
