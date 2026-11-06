/** Isolated status rules. Host adapters own authorization, HP, turn scheduling and persistence.
 * Durations are counted at the affected actor's turn end, not global round end.
 * No default magnitudes, skills or live battle integration are implied.
 */
export type StatusKind = "poison" | "burn" | "freeze" | "stun";
export type Status = { kind: StatusKind; target: string; source: string; magnitude: number; remainingTurns: number };
export type StatusEvent =
  | { type: "status_applied" | "status_refreshed" | "status_advanced" | "status_expired" | "status_removed"; status: Status }
  | { type: "status_damage"; target: string; source: string; kind: "poison" | "burn"; amount: number };
export type StatusResult = { ok: true; statuses: Status[]; events: StatusEvent[] } | { ok: false; reason: string };

const kinds = new Set<StatusKind>(["poison", "burn", "freeze", "stun"]);
function valid(s: Status): boolean {
  return !!s && kinds.has(s.kind) && typeof s.target === "string" && s.target.length > 0 && s.target.length <= 128 &&
    typeof s.source === "string" && s.source.length > 0 && s.source.length <= 128 &&
    Number.isSafeInteger(s.magnitude) && s.magnitude >= 0 && s.magnitude <= 1000 &&
    Number.isSafeInteger(s.remainingTurns) && s.remainingTurns > 0 && s.remainingTurns <= 100;
}
function validList(statuses: readonly Status[]): boolean {
  if (!Array.isArray(statuses) || statuses.length > 1024 || !statuses.every(valid)) return false;
  const keys = new Set(statuses.map(s => JSON.stringify([s.target, s.kind, s.source])));
  return keys.size === statuses.length;
}
function copy(s: Status): Status { return { kind: s.kind, target: s.target, source: s.source, magnitude: s.magnitude, remainingTurns: s.remainingTurns }; }

/** Same source/kind refreshes to the larger magnitude and duration; sources remain independent. */
export function applyStatus(statuses: readonly Status[], status: Status): StatusResult {
  if (!validList(statuses) || !valid(status)) return { ok: false, reason: "invalid_status" };
  const next = statuses.map(copy);
  const index = next.findIndex(s => s.target === status.target && s.kind === status.kind && s.source === status.source);
  const previous = index < 0 ? null : next[index]!;
  const applied = previous ? { ...previous, magnitude: Math.max(previous.magnitude, status.magnitude), remainingTurns: Math.max(previous.remainingTurns, status.remainingTurns) } : copy(status);
  if (index < 0) next.push(applied); else next[index] = applied;
  return { ok: true, statuses: next, events: [{ type: previous ? "status_refreshed" : "status_applied", status: copy(applied) }] };
}

/** Caller must invoke exactly once per actor turn; the host enforces idempotency. */
export function endStatusTurn(statuses: readonly Status[], target: string): StatusResult {
  if (!validList(statuses) || typeof target !== "string" || !target || target.length > 128) return { ok: false, reason: "invalid_status" };
  const next: Status[] = [], events: StatusEvent[] = [];
  for (const entry of statuses) {
    const s = copy(entry);
    if (s.target !== target) { next.push(s); continue; }
    if ((s.kind === "poison" || s.kind === "burn") && s.magnitude > 0) events.push({ type: "status_damage", target: s.target, source: s.source, kind: s.kind, amount: s.magnitude });
    if (--s.remainingTurns === 0) events.push({ type: "status_expired", status: copy(entry) });
    else { next.push(s); events.push({ type: "status_advanced", status: copy(s) }); }
  }
  return { ok: true, statuses: next, events };
}

export function removeStatus(statuses: readonly Status[], target: string, kind: StatusKind): StatusResult {
  if (!validList(statuses) || typeof target !== "string" || !target || target.length > 128 || !kinds.has(kind)) return { ok: false, reason: "invalid_status" };
  const removed = statuses.filter(s => s.target === target && s.kind === kind);
  return { ok: true, statuses: statuses.filter(s => s.target !== target || s.kind !== kind).map(copy), events: removed.map(s => ({ type: "status_removed", status: copy(s) })) };
}

/** Provisional generic control semantics; concrete skills must opt in explicitly. */
export function statusBlocks(statuses: readonly Status[], target: string): { move: boolean; action: boolean } | null {
  if (!validList(statuses) || typeof target !== "string" || !target || target.length > 128) return null;
  return { move: statuses.some(s => s.target === target && (s.kind === "freeze" || s.kind === "stun")), action: statuses.some(s => s.target === target && s.kind === "stun") };
}
