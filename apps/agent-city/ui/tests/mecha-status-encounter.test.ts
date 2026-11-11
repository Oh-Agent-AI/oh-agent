import test from "node:test";
import assert from "node:assert/strict";
import { applyEncounterHit, encounterStatusBlocks, finishEncounterStatusTurn, type StatusEncounterSkill } from "../src/game/mecha/statusEncounter.ts";

test("four confirmed skill hits apply their declared status and misses do not", () => {
  const cases: Array<[StatusEncounterSkill, string, number]> = [
    ["spore_leap", "poison", 2], ["ring_pierce", "burn", 2],
    ["prism_frost", "freeze", 1], ["gravity_collision", "stun", 1],
  ];
  for (const [skill, kind, turns] of cases) {
    const input = { skill, source: "boss", target: "Assault", targetAlive: true, hit: true };
    const result = applyEncounterHit([], input);
    assert.equal(result.statuses[0]?.kind, kind);
    assert.equal(result.statuses[0]?.remainingTurns, turns);
    assert.equal(result.events[0]?.type, "status_applied");
    assert.deepEqual(applyEncounterHit([], { ...input, hit: false }), { statuses: [], events: [] });
    assert.deepEqual(applyEncounterHit([], { ...input, targetAlive: false }), { statuses: [], events: [] });
  }
});

test("damage statuses tick twice and control statuses restrict the affected unit for one turn", () => {
  const poison = applyEncounterHit([], { skill: "spore_leap", source: "boss", target: "Assault", targetAlive: true, hit: true });
  const first = finishEncounterStatusTurn(poison.statuses, "Assault");
  assert.deepEqual(first.events.map(e => e.type), ["status_damage", "status_advanced"]);
  assert.equal(first.statuses[0]?.remainingTurns, 1);
  const second = finishEncounterStatusTurn(first.statuses, "Assault");
  assert.deepEqual(second.events.map(e => e.type), ["status_damage", "status_expired"]);
  assert.deepEqual(second.statuses, []);
  const freeze = applyEncounterHit([], { skill: "prism_frost", source: "boss", target: "Assault", targetAlive: true, hit: true });
  assert.deepEqual(encounterStatusBlocks(freeze.statuses, "Assault"), { move: true, action: false });
  const stun = applyEncounterHit(freeze.statuses, { skill: "gravity_collision", source: "boss", target: "Assault", targetAlive: true, hit: true });
  assert.deepEqual(encounterStatusBlocks(stun.statuses, "Assault"), { move: true, action: true });
  assert.deepEqual(encounterStatusBlocks(stun.statuses, "Gunner"), { move: false, action: false });
  assert.deepEqual(finishEncounterStatusTurn(stun.statuses, "Assault").statuses, []);
});

test("status inputs fail closed and do not mutate an existing ledger", () => {
  const hit = { skill: "ring_pierce" as const, source: "boss", target: "Gunner", targetAlive: true, hit: true };
  const first = applyEncounterHit([], hit), before = structuredClone(first.statuses);
  const refresh = applyEncounterHit(first.statuses, hit);
  assert.equal(refresh.events[0]?.type, "status_refreshed");
  assert.deepEqual(first.statuses, before);
  assert.throws(() => applyEncounterHit(first.statuses, { ...hit, source: "" }), /invalid_status/);
  assert.throws(() => applyEncounterHit(first.statuses, { ...hit, skill: "prism_guard" } as never), /invalid_status_hit/);
});
