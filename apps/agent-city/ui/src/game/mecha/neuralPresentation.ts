/** Verify L8 journal evidence before deriving any link presentation. */
import type { NeuralJournalEvent, NeuralLedger, PresentationStages, TurnEvent } from "./board";

type Cue = { eventIndex: number; change: "created" | "broken"; targetId: string };
type Evidence = { ok: true; cues: Cue[] } | { ok: false };

// Inspection must not execute getters on an untrusted event or snapshot.
function plain(value: unknown, depth = 0, budget = { remaining: 4096 }): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || depth > 16 || --budget.remaining < 0) return false;
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
  if (array ? proto !== Array.prototype || keys.length !== value.length + 1 || value.length > 1024
    : proto !== Object.prototype && proto !== null) return false;
  if (array) for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return false;
  }
  for (const key of keys) {
    if (typeof key !== "string") return false;
    if (array && key === "length") continue;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d) || !plain(d.value, depth + 1, budget)) return false;
  }
  return true;
}
function exact(value: object, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => own.includes(key));
}
function validEvent(event: NeuralJournalEvent): boolean {
  if (!event || typeof event !== "object" || !Number.isSafeInteger(event.round) || event.round < 1) return false;
  if (event.type === "link_created") return exact(event, ["type", "round", "actionId", "link"]) &&
    event.actionId === `neural:${event.round}` && !!event.link && exact(event.link, ["id", "sourceId", "targetId", "range", "attackBonus", "expiresAtRound"]) &&
    typeof event.link.id === "string" && /^neural-link:(0|[1-9][0-9]*)$/.test(event.link.id) && event.link.sourceId === "boss" &&
    typeof event.link.targetId === "string" && event.link.targetId.startsWith("raider:") && event.link.targetId.length > 7 &&
    event.link.range === 3 && event.link.attackBonus === 2 && event.link.expiresAtRound === event.round + 2;
  if (event.type === "link_void") return exact(event, ["type", "round", "actionId", "targetId", "reason"]) &&
    event.actionId === `neural:${event.round}` && typeof event.targetId === "string" && event.targetId.startsWith("raider:") &&
    ["actor_dead", "target_dead", "out_of_range", "finished"].includes(event.reason);
  return event.type === "link_broken" && exact(event, ["type", "round", "linkId", "reason"]) &&
    typeof event.linkId === "string" && ["source_dead", "target_dead", "side_changed", "expired", "out_of_range", "finished"].includes(event.reason);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function verifyNeuralPresentation(stages: PresentationStages, log: readonly TurnEvent[]): Evidence {
  try {
    const snapshots = [stages.before, stages.afterMovement, stages.afterPlayer, stages.afterEnemy, stages.afterPrepare];
    const descriptors = snapshots.map(s => Object.getOwnPropertyDescriptor(s, "neural"));
    if (snapshots.some((s, i) => !descriptors[i] && "neural" in s)) return { ok: false };
    const entries = log.flatMap((item, eventIndex) => {
      const type = item && Object.getOwnPropertyDescriptor(item, "type");
      if (!type || !("value" in type) || type.value !== "neural_event") return [];
      const neuralEvent = item as Extract<TurnEvent, { type: "neural_event" }>;
      if (!plain(item) || !exact(item, ["type", "event"]) || !validEvent(neuralEvent.event)) throw Error("invalid neural event");
      return [{ eventIndex, event: neuralEvent.event }];
    });
    const positions = Object.getOwnPropertyDescriptor(stages, "neuralLogIndices");
    if (!positions && "neuralLogIndices" in stages) return { ok: false };
    if (descriptors.every(d => !d)) return entries.length || positions ? { ok: false } : { ok: true, cues: [] };
    if (!positions?.enumerable || !("value" in positions) || !plain(positions.value) ||
        !Array.isArray(positions.value) || !positions.value.every((index: unknown) => Number.isSafeInteger(index) && (index as number) >= 0) ||
        !same(positions.value, entries.map(entry => entry.eventIndex))) return { ok: false };
    if (descriptors.some(d => !d?.enumerable || !("value" in d) || !plain(d.value))) return { ok: false };
    const ledgers = descriptors.map(d => (d as PropertyDescriptor).value as NeuralLedger);
    if (ledgers.some(n => !n || !Array.isArray(n.journal) || !Array.isArray(n.links) || !n.journal.every(validEvent))) return { ok: false };
    const initial = ledgers[0]!.journal, final = ledgers[4]!.journal;
    if (final.length < initial.length || !same(final.slice(0, initial.length), initial) ||
        !same(final.slice(initial.length), entries.map(e => e.event))) return { ok: false };
    if (!same(ledgers[1]!.journal, initial)) return { ok: false };
    let previous = initial.length;
    for (const ledger of ledgers) {
      if (ledger.journal.length < previous || !same(ledger.journal, final.slice(0, ledger.journal.length))) return { ok: false };
      previous = ledger.journal.length;
    }
    const active = new Map(ledgers[0]!.links.map(link => [link.id, link]));
    if (active.size !== ledgers[0]!.links.length) return { ok: false };
    const binding = ledgers[0]!.pending?.request;
    let nextLinkId = ledgers[0]!.nextLinkId;
    const actions = [...ledgers[0]!.resolvedActions];
    const cues: Cue[] = [];
    let offset = 0;
    for (const ledger of ledgers) {
      const end = ledger.journal.length - initial.length;
      while (offset < end) {
        const item = entries[offset]!, event = item.event;
        if (event.type === "link_created" || event.type === "link_void") {
          const target = event.type === "link_created" ? event.link.targetId : event.targetId;
          if (!binding || binding.skillId !== "neural_link" || event.actionId !== binding.actionId || target !== binding.targetId || actions.includes(event.actionId)) return { ok: false };
          actions.push(event.actionId);
        }
        if (event.type === "link_created") {
          if (event.link.id !== `neural-link:${nextLinkId}` || active.has(event.link.id) || [...active.values()].some(l => l.targetId === event.link.targetId)) return { ok: false };
          nextLinkId++;
          active.set(event.link.id, event.link);
          if (offset < ledgers[3]!.journal.length - initial.length) cues.push({ eventIndex: item.eventIndex, change: "created", targetId: event.link.targetId });
        } else if (event.type === "link_broken") {
          const link = active.get(event.linkId);
          if (!link) return { ok: false };
          active.delete(event.linkId);
          // Reconciliation can run after a boss shove mutates its position but
          // before the shove event is emitted. The log cannot place this beam
          // at the moved endpoint, so keep the journal without inventing a cue.
          if (event.reason !== "out_of_range" && offset < ledgers[3]!.journal.length - initial.length)
            cues.push({ eventIndex: item.eventIndex, change: "broken", targetId: link.targetId });
        }
        offset++;
      }
      if (!same([...active.values()], ledger.links) || ledger.nextLinkId !== nextLinkId || !same(ledger.resolvedActions, actions)) return { ok: false };
    }
    return { ok: true, cues };
  } catch { return { ok: false }; }
}
