/** Token book for mutually exclusive scene/camera ownership.
 *
 *  The book separates the monotonically increasing lease id from the active token:
 *  ids are never reused, and a stale token can never release a newer lease. The
 *  engine's old "id doubles as the active flag, reset to 0 on release" shape let a
 *  late `release()` from lease #1 clear lease #2's frame hook and camera because
 *  the next acquire reused id 1.
 */
export type ModeLeaseToken = { readonly id: number; readonly key: symbol };

export class ModeLeaseBook {
  private nextId = 0;
  private active: symbol | null = null;

  get busy(): boolean {
    return this.active !== null;
  }

  /** Returns `null` when another lease is active; otherwise a fresh token. */
  acquire(): ModeLeaseToken | null {
    if (this.active !== null) return null;
    const key = Symbol("city-mode-lease");
    this.active = key;
    return { id: ++this.nextId, key };
  }

  isCurrent(token: ModeLeaseToken): boolean {
    return this.active === token.key;
  }

  /** Idempotent: only the current token clears the book, and only once. */
  release(token: ModeLeaseToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.active = null;
    return true;
  }
}
