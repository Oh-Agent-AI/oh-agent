import type { MechaPerformanceEvent } from "../../render/mecha/performance";
import type { Status, StatusKind } from "./statusEffects";

export type DisplayStatus = Pick<Status, "target" | "source" | "kind" | "remainingTurns">;
type StatusCue = Extract<MechaPerformanceEvent, { kind: "status_cue" }>;
const order: StatusKind[] = ["poison", "burn", "freeze", "stun"];
const key = (status: DisplayStatus) => JSON.stringify([status.target, status.source, status.kind]);

/** Playback projection only; it cannot change battle state. */
export function applyStatusDisplayCue(statuses: readonly DisplayStatus[], cue: StatusCue): DisplayStatus[] | null {
  if (!cue.actor || !cue.source || !order.includes(cue.status) || !["applied", "refreshed", "advanced", "damage", "expired", "removed"].includes(cue.change)) return null;
  const identity = { target: cue.actor, source: cue.source, kind: cue.status }, id = key({ ...identity, remainingTurns: 1 });
  const next = statuses.map(status => ({ ...status })), index = next.findIndex(status => key(status) === id);
  if (cue.change === "damage") return index < 0 ? null : next;
  if (cue.change === "expired" || cue.change === "removed") {
    if (index < 0 || (cue.change === "expired" && next[index]!.remainingTurns !== 1)) return null;
    next.splice(index, 1); return next;
  }
  if (!Number.isSafeInteger(cue.remainingTurns) || cue.remainingTurns! < 1 || cue.remainingTurns! > 100) return null;
  if (cue.change === "applied" ? index >= 0 : index < 0) return null;
  if (cue.change === "advanced" && next[index]!.remainingTurns !== cue.remainingTurns! + 1) return null;
  if (cue.change === "refreshed" && next[index]!.remainingTurns > cue.remainingTurns!) return null;
  const status = { ...identity, remainingTurns: cue.remainingTurns! };
  if (index < 0) next.push(status); else next[index] = status;
  return next;
}

/** Multiple independent sources of the same status share one badge; details remain in authority state. */
export function describeStatusBadges(statuses: readonly DisplayStatus[], target: string, locale: "en" | "zh-Hans"): { text: string; accessible: string } {
  const en = locale === "en", short = ["☠️", "🔥", "🧊", "💫"];
  const names = en ? ["Poison", "Burn", "Freeze", "Stun"] : ["中毒", "燃烧", "冻结", "眩晕"];
  const text: string[] = [], accessible: string[] = [];
  for (const [index, kind] of order.entries()) {
    const matches = statuses.filter(status => status.target === target && status.kind === kind);
    if (!matches.length) continue;
    const remaining = Math.max(...matches.map(status => status.remainingTurns));
    text.push(`${short[index]}${remaining}`);
    accessible.push(en ? `${names[index]}, up to ${remaining} turns${matches.length > 1 ? `, ${matches.length} sources` : ""}` :
      `${names[index]}，最长剩余 ${remaining} 回合${matches.length > 1 ? `，${matches.length} 个来源` : ""}`);
  }
  return { text: text.join(" · "), accessible: accessible.join(en ? "; " : "；") };
}
