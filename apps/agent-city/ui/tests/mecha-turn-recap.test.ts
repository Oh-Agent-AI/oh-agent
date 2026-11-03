import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnRecap } from "../src/game/mecha/turnRecap.ts";
import type { HealthEffect, TurnEvent } from "../src/game/mecha/board.ts";
import type { HealthTimeline } from "../src/game/mecha/healthTimeline.ts";

const log: TurnEvent[] = [
  { type: "act", mechId: "Assault", action: "melee", damage: 0, fizzled: true },
  { type: "act", mechId: "Support", action: "repair", damage: 0 },
  { type: "enemy", actor: "boss", skill: "smash", cells: [], damage: 2 },
];
function timeline(effects: Array<Omit<HealthEffect, "order">>): HealthTimeline {
  return { ok: true, steps: effects.map((effect, order) => ({ eventIndex: 0, event: log[0]!, effect: { ...effect, order } })) };
}

test("recap uses gross loss, distinct enemy deaths, and actual fizzles", () => {
  const health = timeline([
    { kind: "mech", id: "Assault", before: 10, after: 7 },
    { kind: "mech", id: "Assault", before: 7, after: 9 },
    { kind: "mech", id: "Assault", before: 9, after: 8 },
    { kind: "building", id: "b", before: 3, after: 0 },
    { kind: "boss", id: "boss", before: 5, after: 0 },
    { kind: "raider", id: "r", before: 2, after: 0 },
    { kind: "raider", id: "r", before: 0, after: 1 },
    { kind: "raider", id: "r", before: 1, after: 0 },
  ]);
  const before = structuredClone({ log, health });
  assert.deepEqual(buildTurnRecap(log, health), { fizzledActions: 1, health: { enemiesDown: 2, mechDamage: 4, buildingDamage: 3 } });
  assert.deepEqual({ log, health }, before, "read-only presentation must not mutate input");
});

test("unreconciled or missing timeline is unknown, not zero damage", () => {
  for (const health of [undefined, null, { ok: false, reason: "missing effects" } as const]) {
    assert.deepEqual(buildTurnRecap(log, health), { fizzledActions: 1, health: null });
  }
  assert.deepEqual(buildTurnRecap([], { ok: true, steps: [] }), { fizzledActions: 0, health: { enemiesDown: 0, mechDamage: 0, buildingDamage: 0 } });
});

// Failure explanation is deliberately bounded to the final reconciled turn.
import { MAX_TURNS, bossPrepare, createMatch, playTurn, type ArenaPlan, type MatchState } from "../src/game/mecha/rules.ts";
import { buildHealthTimeline } from "../src/game/mecha/healthTimeline.ts";
import { buildFailureRecap } from "../src/game/mecha/failureRecap.ts";

function failureFixture(): MatchState {
  return createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [],
    boss: { x: 7, y: 0 }, buildings: [
      { id: "defended", cells: [{ x: 3, y: 3 }], hp: 3 },
      { id: "ordinary", cells: [{ x: 8, y: 7 }], hp: 2 },
    ], raiders: [{ id: "raider-w", pos: { x: 2, y: 3 } }],
    mechs: [{ id: "Assault", pos: { x: 6, y: 6 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }],
  });
}

test("final loss follows reconciled effect order and ignores non-defended buildings", () => {
  const before = failureFixture();
  before.stake = "frontage";
  before.terrain[3]![2] = "road";
  const after = structuredClone(before);
  after.buildings.forEach((b) => { b.hp = 0; });
  after.phase = "finished"; after.outcome = "defeat_buildings";
  const events: TurnEvent[] = [
    { type: "enemy", actor: "raider-w", skill: "smash", cells: [], damage: 3, effects: [{ kind: "building", id: "defended", before: 3, after: 0, order: 0 }] },
    { type: "shove", unit: "boss", dir: { x: 0, y: 1 }, hit: "wall", damage: 0, effects: [{ kind: "building", id: "ordinary", before: 2, after: 0, order: 1 }] },
    { type: "outcome", outcome: "defeat_buildings" },
  ];
  const hp = buildHealthTimeline(before, after, events);
  const original = structuredClone({ before, after, events, hp });
  assert.equal(buildFailureRecap(after, events, hp)?.decisive?.effect.id, "defended");
  assert.equal(buildFailureRecap(after, events, hp)?.decisive?.event.type, "enemy");
  assert.deepEqual({ before, after, events, hp }, original);
  assert.equal(buildFailureRecap(after, events, { ok: false, reason: "unreconciled" })?.decisive, null);
  assert.equal(buildFailureRecap(after, events, null)?.decisive, null);
  assert.equal(buildFailureRecap(after, structuredClone(events), hp)?.decisive, null, "stale timeline must not be attributed");
  const mismatch = [...events.slice(0, 2), { type: "outcome", outcome: "defeat_wipe" } as TurnEvent];
  assert.equal(buildFailureRecap(after, mismatch, hp)?.decisive, null);
  const stillAlive = structuredClone(after); stillAlive.buildings[0]!.hp = 1;
  assert.equal(buildFailureRecap(stillAlive, events, hp)?.decisive, null);
});

test("wipe uses final actual death, including unassigned push collision", () => {
  const before = failureFixture();
  const after = structuredClone(before);
  after.mechs.forEach((m) => { m.hp = 0; });
  after.phase = "finished"; after.outcome = "defeat_wipe";
  const events: TurnEvent[] = [
    { type: "act", mechId: "Assault", action: "charge", damage: 0, effects: [{ kind: "mech", id: "Gunner", before: 11, after: 0, order: 0 }] },
    { type: "enemy", actor: "boss", skill: "smash", cells: [], damage: 14, effects: [{ kind: "mech", id: "Assault", before: 14, after: 0, order: 1 }] },
    { type: "shove", unit: "boss", dir: { x: 0, y: 1 }, hit: "Support", damage: 0, effects: [{ kind: "mech", id: "Support", before: 12, after: 0, order: 2 }] },
    { type: "outcome", outcome: "defeat_wipe" },
  ];
  const hp = buildHealthTimeline(before, after, events);
  assert.equal(hp.ok, true);
  const recap = buildFailureRecap(after, events, hp);
  assert.equal(recap?.decisive?.effect.id, "Support");
  assert.equal(recap?.decisive?.event.type, "shove");
  const noEffects = buildHealthTimeline(after, after, [{ type: "outcome", outcome: "defeat_wipe" }]);
  assert.equal(buildFailureRecap(after, [{ type: "outcome", outcome: "defeat_wipe" }], noEffects)?.decisive, null);
});

test("real accepted defeat has reconciled culprit; timeout shows accepted turn", () => {
  const state = failureFixture();
  state.buildings = state.buildings.filter((b) => b.id === "defended");
  state.boss.hp = 0;
  bossPrepare(state);
  state.raiders[0]!.pos = { x: 2, y: 3 };
  state.raiders[0]!.intent = { skillId: "smash", local: [{ x: 1, y: 0 }], projected: [{ x: 3, y: 3 }], cdSweep: 0, status: "planned" };
  const plan: ArenaPlan = { revision: state.revision, items: state.mechs.map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) };
  const result = playTurn(state, plan);
  assert.ok(result.ok);
  assert.equal(result.state.outcome, "defeat_buildings");
  const hp = buildHealthTimeline(state, result.state, result.log);
  assert.equal(hp.ok, true);
  const review = buildFailureRecap(result.state, result.log, hp);
  assert.equal(review?.turn, state.turn);
  assert.equal(review?.decisive?.effect.id, "defended");
  assert.equal(review?.decisive?.event.type, "enemy");
  if (review?.decisive?.event.type === "enemy") assert.equal(review.decisive.event.actor, "raider-w");
  const timeoutStart = failureFixture();
  timeoutStart.boss.hp = 0;
  bossPrepare(timeoutStart);
  timeoutStart.turn = MAX_TURNS;
  timeoutStart.raiders[0]!.intent = { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "planned" };
  const timeoutPlan: ArenaPlan = { revision: timeoutStart.revision, items: timeoutStart.mechs.map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) };
  const timeoutResult = playTurn(timeoutStart, timeoutPlan);
  assert.ok(timeoutResult.ok);
  assert.equal(timeoutResult.state.outcome, "defeat_timeout");
  assert.equal(timeoutResult.state.turn, MAX_TURNS + 1);
  assert.equal(buildFailureRecap(timeoutResult.state, timeoutResult.log, buildHealthTimeline(timeoutStart, timeoutResult.state, timeoutResult.log))?.turn, MAX_TURNS);
  const timeout = structuredClone(result.state); timeout.outcome = "defeat_timeout"; timeout.turn = MAX_TURNS + 1;
  assert.deepEqual(buildFailureRecap(timeout, [], null), { outcome: "defeat_timeout", turn: MAX_TURNS, decisive: null });
  timeout.outcome = "victory";
  assert.equal(buildFailureRecap(timeout, [], null), null);
  timeout.outcome = null; timeout.phase = "player_plan";
  assert.equal(buildFailureRecap(timeout, [], null), null);
});
