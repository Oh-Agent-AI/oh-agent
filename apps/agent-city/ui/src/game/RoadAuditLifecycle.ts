/** Serializes capture→worker audit runs and invalidates late async completions. */
export class RoadAuditRunLock {
  private generation = 0;
  private busy = false;
  get active(): boolean { return this.busy; }
  begin(enabled: boolean): number | null {
    if (!enabled || this.busy) return null;
    this.busy = true;
    return ++this.generation;
  }
  isCurrent(runId: number): boolean { return this.busy && runId === this.generation; }
  sameGeneration(runId: number): boolean { return runId === this.generation; }
  finish(runId: number): boolean {
    if (!this.isCurrent(runId)) return false;
    this.busy = false;
    return true;
  }
  invalidate(): void { this.generation++; this.busy = false; }
}

export function clearOwnedCaptureResources<TTimer, TAbort>(
  runIsCurrent: boolean,
  timerSlot: { current: TTimer | null },
  abortSlot: { current: TAbort | null },
  ownedTimer: TTimer,
  ownedAbort: TAbort,
  clearTimer: (timer: TTimer) => void,
): boolean {
  if (!runIsCurrent) return false;
  if (timerSlot.current === ownedTimer) {
    clearTimer(ownedTimer);
    timerSlot.current = null;
  }
  if (abortSlot.current === ownedAbort) abortSlot.current = null;
  return true;
}

export function auditMustInvalidate(enabled: boolean, runActive: boolean, hasSnapshotCapture: boolean): boolean {
  return !enabled && (runActive || hasSnapshotCapture);
}
