/**
 * Single-owner admission for City activities. This is an in-process host
 * contract, not an extension/plugin API. It closes the race between UI guards
 * and asynchronous scene preparation: ownership is granted synchronously,
 * before an activity awaits City resources.
 */
export type CityActivityId = "flight" | "driving" | "mecha" | "cinema" | "film" | "repair";
export type CityActivityPhase = "preparing" | "running";
export type CityActivitySnapshot = Readonly<{
  activityId: CityActivityId;
  phase: CityActivityPhase;
  runId: number;
}>;

export type CityActivityLease = Readonly<{
  readonly activityId: CityActivityId;
  readonly runId: number;
  activate(): boolean;
  release(): void;
}>;

export type CityActivityAdmission =
  | Readonly<{ ok: true; lease: CityActivityLease }>
  | Readonly<{ ok: false; active: CityActivitySnapshot }>;

type Owner = { token: symbol; snapshot: CityActivitySnapshot };

export class CityActivityCoordinator {
  private owner: Owner | null = null;
  private serial = 0;
  private readonly listeners = new Set<(snapshot: CityActivitySnapshot | null) => void>();

  get snapshot(): CityActivitySnapshot | null { return this.owner?.snapshot ?? null; }

  subscribe(listener: (snapshot: CityActivitySnapshot | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  tryAcquire(activityId: CityActivityId): CityActivityAdmission {
    if (this.owner) return { ok: false, active: this.owner.snapshot };
    const token = Symbol(activityId);
    const runId = ++this.serial;
    const owner: Owner = { token, snapshot: Object.freeze({ activityId, phase: "preparing", runId }) };
    this.owner = owner;
    this.notify();
    let released = false;
    const lease: CityActivityLease = Object.freeze({
      activityId,
      runId,
      activate: () => {
        if (released || this.owner?.token !== token) return false;
        if (owner.snapshot.phase !== "running") {
          owner.snapshot = Object.freeze({ activityId, phase: "running", runId });
          this.notify();
        }
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.owner?.token !== token) return;
        this.owner = null;
        this.notify();
      },
    });
    return { ok: true, lease };
  }

  private notify(): void {
    const snapshot = this.snapshot;
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}
