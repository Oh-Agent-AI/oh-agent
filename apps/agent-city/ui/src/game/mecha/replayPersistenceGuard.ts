/** A save counts only while the exact successfully written entry still exists.
 * Match identity is deliberately local to this live controller; a new match must
 * never inherit another match's saved status. */
export type VerifiedReplaySave<T> = { match: T; key: string; raw: string };

export function hasVerifiedReplaySave<T>(match: T, entries: VerifiedReplaySave<T>[], storage: Pick<Storage, "getItem">): boolean {
  try {
    return entries.some(entry => entry.match === match && storage.getItem(entry.key) === entry.raw);
  } catch {
    // An unreadable store is not evidence that a replay can be recovered.
    return false;
  }
}
