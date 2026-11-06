/** Bounded, in-memory fault timeline for one driving session. It contains only
 * game pose/reason/contact identifiers; it is never persisted or transmitted. */
export type DrivingEventKind = "blocked" | "contact" | "unresolved" | "runtime-error" | "camera-safety";
export type DrivingEvent = Readonly<{
  id: number; atMs: number; kind: DrivingEventKind; x: number; y: number; z: number;
  reason: string | null; obstacleIds: readonly string[];
}>;

export class DrivingEventLog {
  private readonly events: DrivingEvent[] = [];
  private serial = 0;
  private lastSignature = "";
  private lastAtMs = -Infinity;
  constructor(readonly capacity = 64, readonly debounceMs = 1500) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 512 || !Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new Error("invalid-driving-event-log-budget");
    }
  }
  record(input: Omit<DrivingEvent, "id">): DrivingEvent | null {
    if (!Number.isSafeInteger(this.serial + 1) || !Number.isFinite(input.atMs) ||
      ![input.x, input.y, input.z].every(Number.isFinite) ||
      !["blocked", "contact", "unresolved", "runtime-error", "camera-safety"].includes(input.kind) ||
      (input.reason !== null && (typeof input.reason !== "string" || input.reason.length > 256)) ||
      !Array.isArray(input.obstacleIds) || input.obstacleIds.length > 32 || input.obstacleIds.some((id) => typeof id !== "string" || id.length > 256)) return null;
    const obstacleIds = [...new Set(input.obstacleIds)].sort();
    const signature = JSON.stringify([input.kind, input.reason, obstacleIds]);
    if (signature === this.lastSignature && input.atMs - this.lastAtMs < this.debounceMs) return null;
    const event = Object.freeze({ ...input, id: ++this.serial, obstacleIds: Object.freeze(obstacleIds) });
    if (this.events.length === this.capacity) this.events.shift();
    this.events.push(event); this.lastSignature = signature; this.lastAtMs = input.atMs;
    return event;
  }
  snapshot(): readonly DrivingEvent[] { return Object.freeze([...this.events]); }
  clear(): void { this.events.length = 0; this.lastSignature = ""; this.lastAtMs = -Infinity; }
}
