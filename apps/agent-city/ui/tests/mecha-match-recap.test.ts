import assert from "node:assert/strict";
import test from "node:test";
import { buildMatchRecap } from "../src/game/mecha/matchRecap.ts";
import { bossPrepare, createMatch, type MatchState, type TurnEvent } from "../src/game/mecha/rules.ts";

type Round = { before: MatchState; after: MatchState; log: TurnEvent[] };
function fixture(): Round[] {
  const first = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], stake: "all",
    buildings: [{ id: "home", cells: [{ x: 3, y: 3 }], hp: 3 }] });
  bossPrepare(first);
  const second = structuredClone(first);
  second.mechs[0]!.hp = 0;
  second.turn = 2; second.revision++;
  const end = structuredClone(second);
  end.buildings[0]!.hp = 0;
  end.phase = "finished"; end.outcome = "defeat_buildings"; end.revision++;
  return [
    { before: first, after: second, log: [{ type: "enemy", actor: "boss", skill: "smash", cells: [], damage: 14,
      effects: [{ kind: "mech", id: first.mechs[0]!.id, before: first.mechs[0]!.hp, after: 0, order: 0 }] }] },
    { before: second, after: end, log: [{ type: "enemy", actor: "boss", skill: "smash", cells: [], damage: 3,
      effects: [{ kind: "building", id: "home", before: 3, after: 0, order: 0 }] }, { type: "outcome", outcome: "defeat_buildings" }] },
  ];
}

test("match review reports reconciled losses in actual turn order without modifying the record", () => {
  const rounds = fixture(); const original = structuredClone(rounds);
  assert.deepEqual(buildMatchRecap(rounds[1]!.after, rounds), { status: "verified", losses: [
    { turn: 1, kind: "mech", id: "Assault" }, { turn: 2, kind: "building", id: "home" },
  ] });
  assert.deepEqual(rounds, original);
});

test("incomplete, mismatched, stale and unreconciled recordings never claim verified history", () => {
  const rounds = fixture(); const end = rounds[1]!.after;
  assert.deepEqual(buildMatchRecap(end, []), { status: "unavailable" });
  assert.deepEqual(buildMatchRecap(end, rounds.slice(1)), { status: "unavailable" });
  const disconnected = structuredClone(rounds); disconnected[1]!.before.mechs[1]!.hp--;
  assert.deepEqual(buildMatchRecap(end, disconnected), { status: "unavailable" });
  const stale = structuredClone(end); stale.revision++;
  assert.deepEqual(buildMatchRecap(stale, rounds), { status: "unavailable" });
  const invalid = structuredClone(rounds); (invalid[0]!.log[0] as Extract<TurnEvent, { type: "enemy" }>).effects = [];
  assert.deepEqual(buildMatchRecap(end, invalid), { status: "unavailable" });
  const wrongOutcome = structuredClone(rounds); wrongOutcome[1]!.log.pop();
  assert.deepEqual(buildMatchRecap(end, wrongOutcome), { status: "unavailable" });
  const notFinished = structuredClone(end); notFinished.outcome = null; notFinished.phase = "player_plan";
  assert.equal(buildMatchRecap(notFinished, rounds), null);
  const victory = structuredClone(end); victory.outcome = "victory";
  assert.equal(buildMatchRecap(victory, rounds), null);
});

test("timeout without any lost mech or protected building is not reported as a loss", () => {
  const rounds = fixture();
  const before = rounds[0]!.before;
  const after = structuredClone(before); after.phase = "finished"; after.outcome = "defeat_timeout";
  assert.deepEqual(buildMatchRecap(after, [{ before, after, log: [{ type: "outcome", outcome: "defeat_timeout" }] }]), { status: "verified", losses: [] });
});

test("only defended buildings are reported and a repeated loss is counted once", () => {
  const rounds = fixture();
  for (const state of new Set([rounds[0]!.before, rounds[0]!.after, rounds[1]!.before, rounds[1]!.after])) {
    state.stake = "frontage";
    state.terrain[3]![2] = "road";
    state.buildings.push({ id: "ordinary", cells: [{ x: 8, y: 7 }], hp: 2, maxHp: 2 });
  }
  rounds[0]!.after.buildings[1]!.hp = 0;
  rounds[1]!.before.buildings[1]!.hp = 0;
  rounds[1]!.after.buildings[1]!.hp = 0;
  const event = rounds[0]!.log[0] as Extract<TurnEvent, { type: "enemy" }>;
  event.effects!.push({ kind: "building", id: "ordinary", before: 2, after: 0, order: 1 });
  // A revived and lost unit is still listed only at its first observed loss.
  const later = rounds[1]!.log[0] as Extract<TurnEvent, { type: "enemy" }>;
  later.effects!.push({ kind: "mech", id: "Assault", before: 0, after: 1, order: 1 });
  later.effects!.push({ kind: "mech", id: "Assault", before: 1, after: 0, order: 2 });
  assert.deepEqual(buildMatchRecap(rounds[1]!.after, rounds), { status: "verified", losses: [
    { turn: 1, kind: "mech", id: "Assault" }, { turn: 2, kind: "building", id: "home" },
  ] });
});

test("a battle starting after a mech was already lost cannot claim complete history", () => {
  const rounds = fixture();
  rounds[0]!.before.mechs[1]!.hp = 0;
  assert.deepEqual(buildMatchRecap(rounds[1]!.after, rounds), { status: "unavailable" });
});
