import type { ArenaPlan, MatchState, PlanFault, TurnEvent } from "../rules";
import type { PresentationStages } from "../presentationSnapshot";
import type { RemoteArenaV1 } from "./arena";

export const MECHA_NET_PROTOCOL = "mecha-net:v1" as const;
export type MatchMode = "pve" | "pvp";
export type MatchSide = "A" | "B";
export type MatchStatus = "active" | "finished" | "closed";
export type MatchPlayer = { playerId: string; side: MatchSide; role: "host" | "guest" };
export type RevisionState = { revision: number };

export type MatchErrorCode =
  | "unauthenticated" | "forbidden" | "not_your_turn" | "stale_revision" | "duplicate_command"
  | "invalid_plan" | "invalid_message" | "message_too_large" | "match_not_found" | "match_finished"
  | "room_closed" | "host_offline" | "ruleset_mismatch" | "rate_limited" | "unavailable";

export type MatchError = { code: MatchErrorCode; fault?: Pick<PlanFault, "code" | "mechId" | "cause"> };
export type MatchResult<T> = { ok: true; value: T } | { ok: false; error: MatchError };

export type MatchSnapshot<S extends RevisionState = MatchState> = {
  protocol: typeof MECHA_NET_PROTOCOL;
  matchId: string;
  mode: MatchMode;
  ruleset: string;
  status: MatchStatus;
  revision: number;
  players: MatchPlayer[];
  arena: RemoteArenaV1;
  state: S;
};

export type SubmitPlanCommand = {
  type: "plan.submit";
  protocol: typeof MECHA_NET_PROTOCOL;
  matchId: string;
  playerId: string;
  commandId: string;
  baseRevision: number;
  plan: ArenaPlan;
};

export type TurnResolved<S extends RevisionState = MatchState> = {
  type: "turn.resolved";
  protocol: typeof MECHA_NET_PROTOCOL;
  matchId: string;
  playerId: string;
  commandId: string;
  revision: number;
  state: S;
  log: TurnEvent[];
  presentationStages: PresentationStages | null;
};

export type MatchEvent<S extends RevisionState = MatchState> =
  | { type: "match.replaced"; snapshot: MatchSnapshot<S> }
  | { type: "turn.resolved"; result: TurnResolved<S> }
  | { type: "match.closed"; matchId: string; revision: number };

export type RuleTurn<S> =
  | { ok: true; state: S; log: TurnEvent[]; presentationStages: PresentationStages | null }
  | { ok: false; fault: PlanFault };

export interface MatchRuleAdapter<S extends RevisionState> {
  readonly ruleset: string;
  activeSide(state: S): MatchSide | null;
  playTurn(state: S, plan: ArenaPlan): RuleTurn<S>;
  concede?(state: S, side: MatchSide): S;
  isFinished(state: S): boolean;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

const id = (value: unknown, max = 80) => typeof value === "string" && /^[A-Za-z0-9:_-]{1,80}$/.test(value) && value.length <= max;
const revision = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const cell = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return revision(c.x) && revision(c.y) && (c.x as number) < 10 && (c.y as number) < 10;
};
const actionKinds = new Set(["skip", "melee", "shoot", "charge", "pierce", "repair"]);
const mechIds = new Set(["Assault", "Gunner", "Support"]);

function validPlan(value: unknown): value is ArenaPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (!revision(plan.revision) || !Array.isArray(plan.items) || plan.items.length > 3) return false;
  const seen = new Set<string>();
  return plan.items.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const order = item as Record<string, unknown>;
    if (typeof order.mechId !== "string" || !mechIds.has(order.mechId) || seen.has(order.mechId)) return false;
    seen.add(order.mechId);
    if (order.moveTo !== null && !cell(order.moveTo)) return false;
    if (!order.action || typeof order.action !== "object" || Array.isArray(order.action)) return false;
    const action = order.action as Record<string, unknown>;
    if (typeof action.kind !== "string" || !actionKinds.has(action.kind)) return false;
    if (action.kind === "skip") return action.target === undefined;
    if (action.kind === "repair") return typeof action.target === "string" && mechIds.has(action.target);
    return action.target === undefined || id(action.target, 64);
  });
}

export function parseSubmitPlan(value: unknown): MatchResult<SubmitPlanCommand> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: { code: "invalid_message" } };
  const command = value as Record<string, unknown>;
  if (command.protocol !== MECHA_NET_PROTOCOL) return { ok: false, error: { code: "ruleset_mismatch" } };
  if (command.type !== "plan.submit" || !id(command.matchId) || !id(command.playerId) || !id(command.commandId)
    || !revision(command.baseRevision) || !validPlan(command.plan) || command.plan.revision !== command.baseRevision) {
    return { ok: false, error: { code: "invalid_message" } };
  }
  return { ok: true, value: structuredClone(command) as SubmitPlanCommand };
}
