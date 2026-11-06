import type { NeuralLedger } from "./board";

// Read descriptors before values: replay sources may contain accessors or hidden fields.
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = Object.getPrototypeOf(value);
  if (p !== Object.prototype && p !== null) return false;
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return !!d?.enumerable && "value" in d;
  });
}
function list(value: unknown, limit: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return false;
  }
  return true;
}
const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1000000000;
const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128;
function link(v: unknown): boolean {
  return record(v, ["id", "sourceId", "targetId", "range", "attackBonus", "expiresAtRound"]) && id(v.id) && id(v.sourceId) && id(v.targetId) && integer(v.range) && integer(v.attackBonus) && integer(v.expiresAtRound);
}
function intent(v: unknown): boolean {
  if (v === null) return true;
  if (!record(v, ["version", "round", "request"]) || v.version !== 1 || !integer(v.round)) return false;
  const r = v.request;
  return record(r, ["skillId", "actionId", "actorId", "targetId", "range", "attackBonus", "lifetime"]) && r.skillId === "neural_link" && id(r.actionId) && id(r.actorId) && id(r.targetId) && integer(r.range) && integer(r.attackBonus) && integer(r.lifetime);
}
function journalEvent(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const d = Object.getOwnPropertyDescriptor(v, "type");
  if (!d?.enumerable || !("value" in d)) return false;
  if (d.value === "link_created") return record(v, ["type", "round", "actionId", "link"]) && integer(v.round) && id(v.actionId) && link(v.link);
  if (d.value === "link_broken") return record(v, ["type", "round", "linkId", "reason"]) && integer(v.round) && id(v.linkId) && ["source_dead", "target_dead", "side_changed", "expired", "out_of_range", "finished"].includes(v.reason as string);
  if (d.value === "link_void") return record(v, ["type", "round", "actionId", "targetId", "reason"]) && integer(v.round) && id(v.actionId) && id(v.targetId) && ["actor_dead", "target_dead", "out_of_range", "finished"].includes(v.reason as string);
  return false;
}
/** Structural safety gate; callers must also re-execute and compare replay evidence. */
export function isSafeNeuralReplayLedger(v: unknown): v is NeuralLedger {
  try {
    if (!(record(v, ["version", "nextLinkId", "links", "resolvedActions", "pending", "journal"]) && v.version === 1 && integer(v.nextLinkId) && list(v.links, 12) && v.links.every(link) && list(v.resolvedActions, 256) && v.resolvedActions.every(id) && intent(v.pending) && list(v.journal, 4096) && v.journal.every(journalEvent))) return false;
    const active = new Map<string, Record<string, unknown>>(), actions: string[] = [];
    let next = 0, round = 0;
    for (const raw of v.journal) {
      const e = raw as Record<string, unknown>;
      if ((e.round as number) < 1 || (e.round as number) < round) return false;
      round = e.round as number;
      if (e.type === "link_created") {
        const l = e.link as Record<string, unknown>;
        if (l.id !== `neural-link:${next++}` || active.has(l.id as string) || [...active.values()].some(a => a.targetId === l.targetId)) return false;
        active.set(l.id as string, l); actions.push(e.actionId as string);
      } else if (e.type === "link_broken") {
        if (!active.delete(e.linkId as string)) return false;
      } else actions.push(e.actionId as string);
    }
    if (next !== v.nextLinkId || new Set(actions).size !== actions.length || JSON.stringify(actions) !== JSON.stringify(v.resolvedActions) || active.size !== v.links.length) return false;
    return v.links.every(raw => { const l = raw as Record<string, unknown>, a = active.get(l.id as string);
      return !!a && ["id", "sourceId", "targetId", "range", "attackBonus", "expiresAtRound"].every(k => a[k] === l[k]); });
  } catch { return false; }
}
