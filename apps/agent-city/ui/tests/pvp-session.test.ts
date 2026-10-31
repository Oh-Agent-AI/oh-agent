import assert from "node:assert/strict";
import test from "node:test";
import { remoteArenaFromSite } from "../src/game/mecha/contracts/arena.ts";
import { MatchSession } from "../src/game/mecha/session/MatchSession.ts";
import { PVP_MAX_TURNS, createPvpMatch, playPvpTurn, pvpProjection, pvpRules } from "../src/game/mecha/rules/pvp.ts";
import { MECHA_NET_PROTOCOL, type SubmitPlanCommand } from "../src/game/mecha/contracts/match.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";

const arena = remoteArenaFromSite({
  originX: 0, originZ: 0, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)), buildings: [], blocked: [],
  mechs: [{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 5, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }],
  boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
} as CityMechaSite, { arenaId: "duel", sourceRevision: "v1" });

function session() {
  return new MatchSession({ matchId: "m1", mode: "pvp", arena: { ...arena, ruleset: pvpRules.ruleset }, state: createPvpMatch(arena), rules: pvpRules, players: [{ playerId: "owner", side: "A", role: "host" }] });
}
function skip(session: ReturnType<typeof session>, playerId: string): SubmitPlanCommand {
  const snapshot = session.snapshot(playerId);
  assert.ok(snapshot.ok);
  const side = snapshot.value.state.activeSide;
  return { protocol: MECHA_NET_PROTOCOL, type: "plan.submit", matchId: "m1", playerId, commandId: `${playerId}-${snapshot.value.revision}`, baseRevision: snapshot.value.revision,
    plan: { revision: snapshot.value.revision, items: snapshot.value.state.units.filter((unit) => unit.side === side && unit.hp > 0).map((unit) => ({ mechId: unit.kind, moveTo: null, action: { kind: "skip" } })) } };
}

test("approval adds the second side and prevents play before then", () => {
  const match = session();
  assert.deepEqual(match.submitPlan("owner", skip(match, "owner")), { ok: false, error: { code: "unavailable" } });
  assert.equal(match.snapshot("guest").ok, false);
  match.addPlayer({ playerId: "guest", side: "B", role: "guest" });
  assert.equal(match.snapshot("guest").value!.players.length, 2);
  assert.equal(match.submitPlan("guest", skip(match, "guest")).error!.code, "not_your_turn");
  assert.equal(match.submitPlan("owner", skip(match, "owner")).ok, true);
  assert.equal(match.submitPlan("guest", skip(match, "guest")).ok, true);
  assert.equal(match.snapshot("owner").value!.revision, 2);
  const conceded = match.concede("guest");
  assert.ok(conceded.ok);
  assert.equal(conceded.value.state.winner, "A");
  assert.equal(conceded.value.state.revision, 3);
  assert.equal(match.submitPlan("owner", skip(match, "owner")).error!.code, "match_finished");
});

test("both sides have distinct units, symmetric legal movement, and no boss", () => {
  const state = createPvpMatch(arena);
  assert.equal(state.units.length, 6);
  assert.equal(new Set(state.units.map((unit) => unit.id)).size, 6);
  for (const side of ["A", "B"] as const) {
    const projection = pvpProjection(state, side);
    assert.equal(projection.boss.hp, 0);
    assert.equal(projection.mechs.length, 3);
    assert.equal(projection.raiders.length, 3);
  }
  const before = structuredClone(state);
  assert.equal(playPvpTurn(state, { revision: 0, items: [{ mechId: "Assault", moveTo: null, action: { kind: "skip" } }] }).ok, false);
  assert.deepEqual(state, before);
});

test("an authoritative attack damages only the enemy and the turn limit adjudicates", () => {
  const state = createPvpMatch(arena);
  state.units.find((unit) => unit.id === "A:Assault")!.pos = { x: 4, y: 4 };
  state.units.find((unit) => unit.id === "B:Assault")!.pos = { x: 4, y: 3 };
  const result = playPvpTurn(state, { revision: 0, items: [
    { mechId: "Assault", moveTo: null, action: { kind: "melee", target: "B:Assault" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    { mechId: "Support", moveTo: null, action: { kind: "skip" } },
  ] });
  assert.ok(result.ok);
  assert.equal(result.state.units.find((unit) => unit.id === "B:Assault")!.hp, 11);
  assert.equal(result.log.find((event) => event.type === "act")!.damage, 3);
  const limited = { ...result.state, turn: PVP_MAX_TURNS, activeSide: "B" as const };
  const finish = playPvpTurn(limited, { revision: limited.revision, items: limited.units.filter((unit) => unit.side === "B").map((unit) => ({ mechId: unit.kind, moveTo: null, action: { kind: "skip" as const } })) });
  assert.ok(finish.ok);
  assert.equal(finish.state.winner, "A");
});

test("the turn limit covers 30 complete rounds and both projections show the current round", () => {
  let state = createPvpMatch(arena);
  for (let action = 0; action < PVP_MAX_TURNS * 2; action += 1) {
    const expectedRound = Math.floor(action / 2) + 1;
    assert.equal(state.turn, expectedRound);
    assert.equal(pvpProjection(state, "A").turn, expectedRound);
    assert.equal(pvpProjection(state, "B").turn, expectedRound);
    const result = playPvpTurn(state, { revision: state.revision, items: state.units.filter((unit) => unit.side === state.activeSide && unit.hp > 0).map((unit) => ({ mechId: unit.kind, moveTo: null, action: { kind: "skip" as const } })) });
    assert.ok(result.ok);
    state = result.state;
    if (action < PVP_MAX_TURNS * 2 - 1) assert.equal(state.winner, null);
  }
  assert.notEqual(state.winner, null);
});

test("lethal damage reports actual HP loss and ambiguous targets are rejected before mutation", () => {
  const state = createPvpMatch(arena);
  state.units.find((unit) => unit.id === "A:Assault")!.pos = { x: 4, y: 4 };
  state.units.find((unit) => unit.id === "B:Assault")!.pos = { x: 4, y: 3 };
  state.units.find((unit) => unit.id === "B:Assault")!.hp = 2;
  const lethal = playPvpTurn(state, { revision: 0, items: [
    { mechId: "Assault", moveTo: null, action: { kind: "melee", target: "B:Assault" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    { mechId: "Support", moveTo: null, action: { kind: "skip" } },
  ] });
  assert.ok(lethal.ok);
  assert.equal(lethal.log.find((event) => event.type === "act")!.damage, 2);

  const ambiguous = createPvpMatch(arena);
  ambiguous.units.find((unit) => unit.id === "A:Gunner")!.pos = { x: 4, y: 4 };
  ambiguous.units.find((unit) => unit.id === "B:Assault")!.pos = { x: 4, y: 2 };
  ambiguous.units.find((unit) => unit.id === "B:Gunner")!.pos = { x: 6, y: 4 };
  const before = structuredClone(ambiguous);
  const invalid = playPvpTurn(ambiguous, { revision: 0, items: [
    { mechId: "Assault", moveTo: null, action: { kind: "skip" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "shoot" } },
    { mechId: "Support", moveTo: null, action: { kind: "skip" } },
  ] });
  assert.equal(invalid.ok, false);
  assert.deepEqual(ambiguous, before);
});
