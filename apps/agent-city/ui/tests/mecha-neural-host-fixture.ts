/** Synthetic L8 host for tests only. Not a live adapter, replay parser, or authority. */
import { BOARD, MAX_TURNS, STATS, enemyStatsOf, type Cell, type MatchState, type MechId, type Outcome } from "../src/game/mecha/board.ts";
import { hurtMech, strike } from "../src/game/mecha/combat.ts";
import {
  advanceSwarmRound, linkedAttackBonus, prepareSwarmLink, reconcileSwarmLink, reprojectSwarmLink, resolveSwarmLink,
  type NeuralLink, type SwarmIntent, type SwarmLinkState, type SwarmProjection,
} from "../src/game/mecha/skillSwarmLink.ts";

// Deliberately provisional fixture values, NOT product balance or trusted rules.
const RANGE = 3, BONUS = 2, LIFETIME = 2;
const node = (id: string) => `raider:${id}`;
export type NeuralBattle = {
  version: 1; match: MatchState; nextLinkId: number; resolvedActions: string[];
  links: NeuralLink[]; pending: { intent: SwarmIntent; declared: SwarmProjection; declaredEndpoints: { source: Cell; target: Cell } } | null;
};
export type NeuralEvent =
  | { type: "neural_declared"; intent: SwarmIntent; projection: SwarmProjection; endpoints: { source: Cell; target: Cell } }
  | { type: "neural_void"; actionId: string; targetId: string; reason: string }
  | { type: "link_created"; link: NeuralLink }
  | { type: "link_broken"; linkId: string; reason: "source_dead" | "target_dead" | "side_changed" | "expired" | "out_of_range" | "finished" }
  | { type: "synthetic_attack"; actorId: string; target: MechId; baseAttack: number; bonus: number; damage: number }
  | { type: "outcome"; outcome: Outcome };
export type NeuralResult =
  | { status: "resolved"; battle: NeuralBattle; events: NeuralEvent[] }
  | { status: "void"; reason: string; battle: NeuralBattle; events: [] };
const clone = <T>(value: T): T => structuredClone(value);
const fail = (battle: NeuralBattle, reason: string): NeuralResult => ({ status: "void", reason, battle, events: [] });
const done = (battle: NeuralBattle, events: NeuralEvent[] = []): NeuralResult => ({ status: "resolved", battle, events });

/** Only ordinary local matches; L5 summons, real monster content and missions need a separate integration design. */
export function createNeuralBattle(match: MatchState): NeuralBattle {
  if (match.outcome || match.phase === "finished" || match.mission || match.monsterContent || match.swarm || match.neural ||
      match.raiders.some(r => r.summon)) throw new Error("neural_fixture_unavailable");
  return { version: 1, match: clone(match), nextLinkId: 0, resolvedActions: [], links: [], pending: null };
}

function world(b: NeuralBattle): SwarmLinkState {
  return { version: 1, width: BOARD, height: BOARD, round: b.match.turn, finished: !!b.match.outcome || b.match.phase === "finished",
    blocked: [], units: [
      { id: "boss", side: "enemy", cell: clone(b.match.boss.anchor), width: 2, height: 2, hp: b.match.boss.hp },
      ...b.match.raiders.map(r => ({ id: node(r.id), side: "enemy", cell: clone(r.pos), width: 1, height: 1, hp: r.hp })),
      ...b.match.mechs.map(m => ({ id: `mech:${m.id}`, side: "player", cell: clone(m.pos), width: 1, height: 1, hp: m.hp })),
    ], links: clone(b.links), nextLinkId: b.nextLinkId, nextSpawnId: 0, resolvedActions: [...b.resolvedActions] };
}
/** Validate fixture invariants, not hostile JSON. Production needs schema-only bounded input and authorization. */
function valid(b: NeuralBattle): boolean {
  if (!b || b.version !== 1 || !b.match || b.match.mission || b.match.monsterContent || b.match.swarm ||
      !Array.isArray(b.match.raiders) || !Array.isArray(b.match.mechs) || b.match.raiders.some(r => r.summon) ||
      !Number.isSafeInteger(b.match.turn) || b.match.turn < 1 || b.match.turn > MAX_TURNS ||
      !Number.isSafeInteger(b.nextLinkId) || b.nextLinkId < 0 || b.nextLinkId > 1000000000 ||
      !Array.isArray(b.links) || !Array.isArray(b.resolvedActions) || b.resolvedActions.length > 256 ||
      b.resolvedActions.some(a => !/^neural:[1-9][0-9]*$/.test(a) || Number(a.slice(7)) > b.match.turn) ||
      new Set(b.resolvedActions).size !== b.resolvedActions.length) return false;
  const ids = new Set(b.match.raiders.map(r => node(r.id)));
  if (ids.size !== b.match.raiders.length) return false;
  for (const l of b.links) {
    const suffix = /^neural-link:(0|[1-9][0-9]*)$/.exec(l.id);
    if (!suffix || Number(suffix[1]) >= b.nextLinkId || l.sourceId !== "boss" || !l.targetId.startsWith("raider:") ||
        l.range !== RANGE || l.attackBonus !== BONUS || !Number.isSafeInteger(l.expiresAtRound)) return false;
  }
  if (b.pending !== null) {
    const i = b.pending?.intent, r = i?.request;
    if (!i || i.version !== 1 || i.round !== b.match.turn || !r || r.skillId !== "neural_link" ||
        r.actionId !== `neural:${i.round}` || r.actorId !== "boss" || !r.targetId.startsWith("raider:") ||
        r.range !== RANGE || r.attackBonus !== BONUS || r.lifetime !== LIFETIME ||
        b.resolvedActions.includes(r.actionId) || b.pending.declared.status !== "reprojected" ||
        b.pending.declared.skillId !== "neural_link" || b.pending.declared.targetId !== r.targetId) return false;
  }
  // The rule primitive validates overlap, counters, units, bounds, and link uniqueness.
  const checked = reconcileSwarmLink(world(b));
  return checked.status === "resolved" || checked.reason === "finished";
}
function dirty(b: NeuralBattle): boolean {
  const checked = reconcileSwarmLink(world(b));
  return checked.status === "resolved" && checked.events.length !== 0;
}

/** Bind one eligible ordinary raider once, with stable ID order independent of array order. */
export function prepareNeuralBattle(b: NeuralBattle): NeuralResult {
  if (!valid(b)) return fail(b, "invalid_state");
  if (b.match.outcome || b.match.phase === "finished") return fail(b, "finished");
  if (b.pending) return fail(b, "pending_intent");
  if (dirty(b)) return fail(b, "reconciliation_required");
  if (b.resolvedActions.includes(`neural:${b.match.turn}`)) return fail(b, "already_resolved");
  if (b.match.boss.hp <= 0) return fail(b, "actor_dead");
  for (const r of [...b.match.raiders].sort((a, c) => a.id < c.id ? -1 : a.id > c.id ? 1 : 0)) {
    const plan = prepareSwarmLink(world(b), { skillId: "neural_link", actionId: `neural:${b.match.turn}`,
      actorId: "boss", targetId: node(r.id), range: RANGE, attackBonus: BONUS, lifetime: LIFETIME });
    if (plan.status !== "planned") {
      if (["target_dead", "out_of_range", "target_already_linked"].includes(plan.reason)) continue;
      return fail(b, plan.reason);
    }
    const endpoints = { source: clone(b.match.boss.anchor), target: clone(r.pos) };
    const next = clone(b); next.pending = { intent: clone(plan.intent), declared: clone(plan.projection), declaredEndpoints: clone(endpoints) };
    return done(next, [{ type: "neural_declared", intent: clone(plan.intent), projection: clone(plan.projection), endpoints }]);
  }
  return fail(b, "no_eligible_node");
}

export function projectNeuralBattle(b: NeuralBattle): SwarmProjection {
  if (!valid(b)) return { status: "void", reason: "invalid_state" };
  if (!b.pending) return { status: "void", reason: "no_intent" };
  if (dirty(b)) return { status: "void", reason: "reconciliation_required" };
  return reprojectSwarmLink(world(b), b.pending.intent);
}
/** Original declaration and current endpoint facts are separate from the primitive projection. */
export function inspectNeuralBattle(b: NeuralBattle): { declared: { source: Cell; target: Cell }; current: { source: Cell; target: Cell | null }; projection: SwarmProjection } | null {
  if (!valid(b) || !b.pending || b.pending.intent.request.skillId !== "neural_link") return null;
  const targetId = b.pending.intent.request.targetId;
  const target = b.match.raiders.find(r => node(r.id) === targetId);
  return { declared: clone(b.pending.declaredEndpoints), current: { source: clone(b.match.boss.anchor), target: target ? clone(target.pos) : null }, projection: projectNeuralBattle(b) };
}
export function resolveNeuralBattle(b: NeuralBattle, expected?: SwarmProjection): NeuralResult {
  if (!valid(b)) return fail(b, "invalid_state");
  if (!b.pending) return fail(b, "no_intent");
  if (dirty(b)) return fail(b, "reconciliation_required");
  const r = resolveSwarmLink(world(b), b.pending.intent, expected);
  if (r.status === "void") return fail(b, r.reason);
  const next = clone(b); next.pending = null; next.links = clone(r.state.links);
  next.nextLinkId = r.state.nextLinkId; next.resolvedActions = [...r.state.resolvedActions];
  const events: NeuralEvent[] = r.events.filter((e): e is Extract<typeof e, { type: "link_created" }> => e.type === "link_created").map(clone);
  return done(next, events);
}
/** Consume a now-impossible bound action; never silently reselect another node. */
export function cancelNeuralBattle(b: NeuralBattle): NeuralResult {
  if (!valid(b)) return fail(b, "invalid_state");
  if (!b.pending) return fail(b, "no_intent");
  const projection = projectNeuralBattle(b);
  if (projection.status !== "void" || !["actor_dead", "target_dead", "out_of_range", "not_allied"].includes(projection.reason)) return fail(b, "intent_not_cancelable");
  const r = b.pending.intent.request;
  if (r.skillId !== "neural_link") return fail(b, "invalid_state");
  const next = clone(b); next.pending = null; next.resolvedActions.push(r.actionId);
  return done(next, [{ type: "neural_void", actionId: r.actionId, targetId: r.targetId, reason: projection.reason }]);
}
export function reconcileNeuralBattle(b: NeuralBattle): NeuralResult {
  if (!valid(b)) return fail(b, "invalid_state");
  const r = reconcileSwarmLink(world(b));
  if (r.status === "void") return fail(b, r.reason);
  const next = clone(b); next.links = clone(r.state.links);
  return done(next, r.events.filter((e): e is Extract<typeof e, { type: "link_broken" }> => e.type === "link_broken").map(clone));
}
export function advanceNeuralBattle(b: NeuralBattle): NeuralResult {
  if (!valid(b)) return fail(b, "invalid_state");
  if (b.match.outcome || b.match.phase === "finished") return fail(b, "finished");
  if (b.pending) return fail(b, "pending_intent");
  if (dirty(b)) return fail(b, "reconciliation_required");
  if (b.match.turn >= MAX_TURNS) return fail(b, "round_limit");
  const r = advanceSwarmRound(world(b));
  if (r.status === "void") return fail(b, r.reason);
  const next = clone(b); next.match.turn = r.state.round; next.links = clone(r.state.links);
  return done(next, r.events.filter((e): e is Extract<typeof e, { type: "link_broken" }> => e.type === "link_broken").map(clone));
}
/** Test-only arithmetic: not actual attack legality, range, animation, turn, or outcome. */
export function attackNeuralBattle(b: NeuralBattle, raiderId: string, target: MechId): NeuralResult {
  if (!valid(b)) return fail(b, "invalid_state");
  if (b.match.outcome || b.match.phase === "finished") return fail(b, "finished");
  if (dirty(b)) return fail(b, "reconciliation_required");
  if (!b.match.raiders.some(r => r.id === raiderId && r.hp > 0)) return fail(b, "actor_dead");
  if (!b.match.mechs.some(m => m.id === target && m.hp > 0)) return fail(b, "target_dead");
  const bonus = linkedAttackBonus(world(b), node(raiderId)), baseAttack = enemyStatsOf(b.match).raiderAtk;
  const next = clone(b), before = next.match.mechs.find(m => m.id === target)!.hp;
  hurtMech(next.match, target, strike(baseAttack + bonus, STATS[target].def));
  const damage = before - next.match.mechs.find(m => m.id === target)!.hp;
  return done(next, [{ type: "synthetic_attack", actorId: node(raiderId), target, baseAttack, bonus, damage }]);
}
/** Host-owned finish semantics: reconcile first, then tear down remaining links, then outcome. */
export function finishNeuralBattle(b: NeuralBattle, outcome: Outcome): NeuralResult {
  if (!valid(b)) return fail(b, "invalid_state");
  if (b.match.outcome || b.match.phase === "finished") return fail(b, "finished");
  const reconciled = reconcileNeuralBattle(b);
  if (reconciled.status === "void") return reconciled;
  const next = reconciled.battle, events = [...reconciled.events];
  if (next.pending && next.pending.intent.request.skillId === "neural_link") {
    const request = next.pending.intent.request;
    events.push({ type: "neural_void", actionId: request.actionId, targetId: request.targetId, reason: "finished" });
    next.resolvedActions.push(request.actionId); next.pending = null;
  }
  for (const link of next.links) events.push({ type: "link_broken", linkId: link.id, reason: "finished" });
  next.links = []; next.match.outcome = outcome; next.match.phase = "finished";
  events.push({ type: "outcome", outcome });
  return done(next, events);
}
