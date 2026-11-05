import assert from "node:assert/strict";
import test from "node:test";
import { createRoundPerformance, performanceFromLog } from "../src/game/mecha/performance.ts";
import { buildPresentationChanges } from "../src/game/mecha/presentationChanges.ts";
import { bossPrepare, createMatch, playTurn, type ArenaPlan, type MatchState, type TurnEvent } from "../src/game/mecha/rules.ts";

function prepared(neural = true): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 4 },
    raiders: [{ id: "a", pos: { x: 3, y: 4 } }],
    mechs: [{ id: "Assault", pos: { x: 2, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 1, y: 9 } }],
    ...(neural ? { monsterContent: { speciesId: "neural_weaver" as const, contentVersion: 1 as const } } : {}) });
  bossPrepare(state);
  return state;
}
function hold(state: MatchState): ArenaPlan {
  return { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) };
}

test("real L8 turn does not invent boss attack while linked raider attack remains", () => {
  const before = prepared(), plan = hold(before);
  assert.equal(before.boss.intent?.skillId, "neural_link");
  assert.notEqual(before.boss.intent?.status, "void");
  const result = playTurn(before, plan);
  assert.equal(result.ok, true); if (!result.ok) throw Error("turn failed");
  assert.ok(result.state.neural?.journal.some(event => event.type === "link_created"));
  assert.ok(result.log.some(event => event.type === "enemy" && event.actor === "a"));
  const cues = performanceFromLog(before, result.state, result.log);
  assert.ok(!cues.some(c => c.kind === "attack" && c.actor === "boss"));
  assert.ok(cues.some(c => c.kind === "attack" && c.actor === "a"));
  assert.ok(result.presentationStages);
  const changes = buildPresentationChanges(result.presentationStages, result.log);
  assert.equal(changes.ok, true, JSON.stringify(changes));
  const verified = performanceFromLog(before, result.state, result.log, { presentationChanges: changes });
  assert.ok(!verified.some(c => c.kind === "attack" && c.actor === "boss"));
  assert.ok(verified.some(c => c.kind === "attack" && c.actor === "a"));
  const fallback = createRoundPerformance(before, plan, before, result.state, result.state);
  assert.ok(!fallback.some(c => c.kind === "attack" && c.actor === "boss"));
  assert.ok(fallback.some(c => c.kind === "attack" && c.actor === "a"));
});

test("explicit neural enemy log, if supplied, is not misrepresented as smash", () => {
  const before = prepared(), after = structuredClone(before);
  const log: TurnEvent[] = [
    { type: "enemy", actor: "boss", skill: "neural_link", cells: [{ x: 2, y: 4 }], damage: 0 },
    { type: "enemy", actor: "a", skill: "smash", cells: [{ x: 2, y: 4 }], damage: 1 },
  ];
  const cues = performanceFromLog(before, after, log);
  assert.ok(!cues.some(c => c.kind === "attack" && c.actor === "boss"));
  assert.ok(cues.some(c => c.kind === "attack" && c.actor === "a" && c.sourceLogIndex === 1));
});

test("ordinary boss smash continues to animate in snapshot and log paths", () => {
  const state = prepared(false), plan = hold(state);
  assert.equal(state.boss.intent?.skillId, "smash");
  assert.ok(createRoundPerformance(state, plan, state, state, state).some(c => c.kind === "attack" && c.actor === "boss" && c.attack === "smash"));
  const log: TurnEvent[] = [{ type: "enemy", actor: "boss", skill: "smash", cells: [{ x: 4, y: 6 }], damage: 0 }];
  assert.ok(performanceFromLog(state, state, log).some(c => c.kind === "attack" && c.actor === "boss" && c.attack === "smash"));
});
