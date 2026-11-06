/** Deterministic work accounting. A planning attempt owns one ledger across
 * request retries, repair drafts and radius attempts; rejection never refunds
 * work already done. This primitive does not itself schedule or publish work. */
export const PLANNING_WORK_UNITS = ["candidate", "terrainSample", "expandedState", "cloneRow", "transaction", "radiusAttempt", "derivedRow"] as const;
export type PlanningWorkUnit = typeof PLANNING_WORK_UNITS[number];
export type PlanningWorkCounts = Readonly<Record<PlanningWorkUnit, number>>;
export type PlanningStop =
  | { readonly status: "cancelled"; readonly stage: string }
  | { readonly status: "budget-exhausted"; readonly stage: string; readonly unit: PlanningWorkUnit;
      readonly requested: number; readonly consumed: number; readonly limit: number };
export class PlanningInterrupted extends Error {
  readonly code = "city-planning-interrupted";
  readonly detail: PlanningStop;
  constructor(detail: PlanningStop) {
    super(detail.status === "cancelled" ? `planning-cancelled:${detail.stage}`
      : `planning-budget-exhausted:${detail.stage}:${detail.unit}`);
    this.name = "PlanningInterrupted";
    this.detail = Object.freeze({ ...detail });
  }
}
export type PlanningWorkSnapshot = {
  readonly limits: PlanningWorkCounts;
  readonly consumed: PlanningWorkCounts;
  readonly stop?: PlanningStop;
};
export type PlanningWorkLedger = {
  /** Charge before doing work. Multi-unit charges are atomic; an over-limit
   * request performs no work and terminally stops this whole planning job. */
  readonly spend: (stage: string, charge: Partial<Record<PlanningWorkUnit, number>>) => void;
  readonly check: (stage: string) => void;
  readonly snapshot: () => PlanningWorkSnapshot;
};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const stageValid = (stage: string) => typeof stage === "string" && stage.length > 0 && stage.length <= 128;
/** Tests/adapters may load separate bundles; terminal stops must not be
 * swallowed merely because their Error constructor has a different identity. */
export function isPlanningInterrupted(error: unknown): error is PlanningInterrupted {
  if (!error || typeof error !== "object") return false;
  const value = error as Partial<PlanningInterrupted>, detail = value.detail;
  if (value.code !== "city-planning-interrupted" || !detail || !stageValid(detail.stage)) return false;
  return detail.status === "cancelled" || (detail.status === "budget-exhausted"
    && PLANNING_WORK_UNITS.includes(detail.unit) && count(detail.requested) && count(detail.consumed) && count(detail.limit));
}

export function createPlanningWorkLedger(input: PlanningWorkCounts, isCancelled: () => boolean = () => false,
  onCheckpoint?: (snapshot: PlanningWorkSnapshot) => void): PlanningWorkLedger {
  const limits = Object.freeze({ ...input });
  if (!input || Object.keys(limits).length !== PLANNING_WORK_UNITS.length
    || PLANNING_WORK_UNITS.some(unit => !Object.hasOwn(limits, unit) || !count(limits[unit])))
    throw new Error("invalid-planning-work-limits");
  const consumed = Object.fromEntries(PLANNING_WORK_UNITS.map(unit => [unit, 0])) as Record<PlanningWorkUnit, number>;
  let stop: PlanningInterrupted | undefined;
  let checkpointCalls = 0;
  const snapshot = (): PlanningWorkSnapshot => Object.freeze({ limits,
    consumed: Object.freeze({ ...consumed }), ...(stop ? { stop: stop.detail } : {}) });
  const check = (stage: string) => {
    if (!stageValid(stage)) throw new Error("invalid-planning-work-stage");
    if (stop) throw stop;
    if (isCancelled()) { stop = new PlanningInterrupted({ status: "cancelled", stage }); throw stop; }
  };
  const spend = (stage: string, charge: Partial<Record<PlanningWorkUnit, number>>) => {
    check(stage);
    if (!charge || typeof charge !== "object" || Array.isArray(charge)
      || (Object.getPrototypeOf(charge) !== Object.prototype && Object.getPrototypeOf(charge) !== null))
      throw new Error("invalid-planning-work-charge");
    const charges = { ...charge };
    const units = Object.keys(charges) as PlanningWorkUnit[];
    if (units.some(unit => !PLANNING_WORK_UNITS.includes(unit) || !count(charges[unit])))
      throw new Error("invalid-planning-work-charge");
    // Fixed dimension order makes the reported first exhausted unit independent
    // of caller property ordering, without changing the candidate ordering.
    units.sort((a, b) => PLANNING_WORK_UNITS.indexOf(a) - PLANNING_WORK_UNITS.indexOf(b));
    for (const unit of units) {
      const amount = charges[unit]!;
      if (amount > limits[unit] - consumed[unit]) {
        stop = new PlanningInterrupted({ status: "budget-exhausted", stage, unit,
          requested: amount, consumed: consumed[unit], limit: limits[unit] });
        throw stop;
      }
    }
    for (const unit of units) consumed[unit] += charges[unit]!;
    if (onCheckpoint && checkpointCalls++ % 50000 === 0) {
      try { onCheckpoint(snapshot()); }
      catch { stop = new PlanningInterrupted({ status: "cancelled", stage: "job:checkpoint" }); throw stop; }
    }
  };
  return Object.freeze({ check, spend, snapshot });
}

// Existing planning is synchronous. Scope the one job ledger without adding it
// to cloned geometry or letting nested retries install a fresh allowance.
let activeLedger: PlanningWorkLedger | undefined;
export function withPlanningWorkLedger<T>(ledger: PlanningWorkLedger, run: () => T): T {
  if (activeLedger && activeLedger !== ledger) throw new Error("planning-work-ledger-replacement-refused");
  const previous = activeLedger; activeLedger = ledger;
  try {
    ledger.check("job:start");
    const result = run();
    if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("async-planning-work-scope-unsupported");
    ledger.check("job:publication");
    return result;
  } finally { activeLedger = previous; }
}
export function spendPlanningWork(stage: string, charge: Partial<Record<PlanningWorkUnit, number>>): void {
  activeLedger?.spend(stage, charge);
}
export function checkPlanningWork(stage: string): void { activeLedger?.check(stage); }
export function hasPlanningWorkLedger(): boolean { return activeLedger !== undefined; }
/** No charge-object allocation when a compatibility caller has no job ledger. */
export function spendPlanningUnit(stage: string, unit: PlanningWorkUnit, amount = 1): void {
  activeLedger?.spend(stage, { [unit]: amount });
}
