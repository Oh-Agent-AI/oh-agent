import assert from "node:assert/strict";
import test from "node:test";
import { MECH_IDS, MAX_TURNS, pathDistance, rescueReachable, type ArenaPlan, type MatchState } from "../src/game/mecha/board.ts";
import { applyDeployPlan, bossPrepare, createMatch, deployableCells, playTurn, previewPlan, validateAndApplyPlan } from "../src/game/mecha/rules.ts";
import { refresh } from "../src/game/mecha/combat.ts";

const opts = { preset: "covers_sparse_mid" as const, script: "stationary_smash" as const, covers: [], boss: { x: 4, y: 0 } };
const skips = (s: MatchState): ArenaPlan => ({ revision: s.revision, items: s.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) });
const prepared = () => { const state = createMatch({ ...opts, mission: "rescue:v1" }); bossPrepare(state); return state; };

test("rescue point is deterministic, empty, reachable in the prepared opening, and absent from legacy JSON", () => {
  const a = prepared(), b = prepared();
  assert.deepEqual(a, b);
  assert.ok(a.mission);
  assert.ok(rescueReachable(a, a.mission.target));
  assert.ok(a.mechs.some(m => pathDistance(a, m.pos, a.mission!.target, m.id, { alliesPass: true }) !== null));
  const legacy = createMatch(opts);
  assert.equal(Object.hasOwn(legacy, "mission"), false);
  assert.equal(JSON.stringify(legacy).includes("rescue"), false);
});

test("deployment preserves the point and rejects an opening blocked after preparation", () => {
  const original = createMatch({ ...opts, deployment: true, mission: "rescue:v1" });
  const cells = deployableCells(original);
  const plan = { revision: original.revision, placements: MECH_IDS.map((mechId, i) => ({ mechId, pos: cells[i]! })) };
  const deployed = applyDeployPlan(original, plan);
  assert.ok(deployed.ok);
  assert.deepEqual(deployed.state.mission, original.mission);
  assert.ok(rescueReachable(deployed.state, original.mission!.target));
  assert.equal(deployed.state.revision, 1);
  const inaccessible = structuredClone(original);
  inaccessible.mission!.target = { ...inaccessible.boss.anchor };
  const blocked = applyDeployPlan(inaccessible, plan);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.fault.code, "rescue_unreachable");
  assert.equal(inaccessible.phase, "deployment");
});

test("a valid whole pack wins after movement, before attacks or enemies; preview and direct settlement agree", () => {
  const state = prepared();
  state.mission!.target = { x: state.mechs[0]!.pos.x, y: state.mechs[0]!.pos.y - 1 };
  // Support has a valid repair action in the post-move position; it must not run.
  state.mechs[2]!.pos = { x: state.mission!.target.x + 1, y: state.mission!.target.y };
  state.mechs[0]!.hp -= 1;
  const plan = skips(state);
  plan.items[0]!.moveTo = { ...state.mission!.target };
  plan.items[2]!.action = { kind: "repair", target: "Assault" };
  const before = structuredClone(state);
  const preview = previewPlan(state, plan);
  const turn = playTurn(state, plan);
  assert.ok(preview.ok && turn.ok);
  assert.equal(preview.outcome, "victory");
  assert.deepEqual(preview.log, turn.log);
  assert.equal(turn.state.outcome, "victory");
  assert.equal(turn.state.phase, "finished");
  assert.equal(turn.state.revision, state.revision + 1);
  assert.equal(turn.state.mechs[0]!.hp, state.mechs[0]!.hp);
  assert.deepEqual(turn.log.map(e => e.type), ["move", "outcome"]);
  assert.deepEqual(state, before);
  const direct = structuredClone(state);
  assert.deepEqual(validateAndApplyPlan(direct, plan), { ok: true });
  assert.deepEqual(direct, turn.state);
  assert.deepEqual(turn.presentationStages?.afterEnemy, turn.presentationStages?.afterPlayer);
});

test("an invalid action or occupied destination rejects the whole rescue packet without victory", () => {
  const state = prepared();
  state.mission!.target = { x: state.mechs[0]!.pos.x, y: state.mechs[0]!.pos.y - 1 };
  const bad = skips(state);
  bad.items[0]!.moveTo = state.mission.target;
  bad.items[1]!.action = { kind: "repair", target: "Assault" };
  const before = structuredClone(state);
  assert.equal(playTurn(state, bad).ok, false);
  assert.equal(previewPlan(state, bad).ok, false);
  assert.deepEqual(state, before);
  bad.items[1]!.action = { kind: "skip" };
  bad.items[1]!.moveTo = state.mission.target;
  assert.equal(playTurn(state, bad).ok, false);
  assert.deepEqual(state, before);
});

test("rescue ignores enemy elimination and building loss, but wipe and last-turn timeout fail", () => {
  const state = prepared();
  state.boss.hp = 0; state.raiders.forEach(r => { r.hp = 0; });
  state.buildings = [{ id: "b", cells: [{ x: 0, y: 0 }], hp: 0, maxHp: 1 }];
  refresh(state);
  assert.equal(state.outcome, null);
  const one = playTurn(state, skips(state));
  assert.ok(one.ok);
  assert.equal(one.state.phase, "player_plan");
  assert.equal(one.state.outcome, null);
  const last = structuredClone(one.state); last.turn = MAX_TURNS;
  const timed = playTurn(last, skips(last));
  assert.ok(timed.ok);
  assert.equal(timed.state.outcome, "defeat_timeout");
  const finalMove = structuredClone(last);
  finalMove.mission!.target = { ...finalMove.mechs[0]!.pos };
  const success = playTurn(finalMove, skips(finalMove));
  assert.ok(success.ok);
  assert.equal(success.state.outcome, "victory");
  const wiped = structuredClone(state); wiped.mechs.forEach(m => { m.hp = 0; });
  refresh(wiped);
  assert.equal(wiped.outcome, "defeat_wipe");
  const legacy = createMatch(opts); legacy.boss.hp = 0; refresh(legacy);
  assert.equal(legacy.outcome, "victory");
});

test("impossible maps fail closed rather than exposing an unreachable point", () => {
  const terrain = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "water" as const));
  assert.throws(() => createMatch({ ...opts, terrain, mission: "rescue:v1" }), /rescue_unavailable/);
});

test("enemy damage wipes the last mech before timeout, but never after rescue movement", () => {
  const state = prepared();
  const survivor = state.mechs[0]!;
  survivor.pos = { x: 4, y: 2 }; survivor.hp = 1;
  state.mechs[1]!.hp = 0; state.mechs[2]!.hp = 0;
  state.boss.intent = { skillId: "smash", local: [{ x: 0, y: 2 }], projected: [{ ...survivor.pos }], cdSweep: 0, status: "planned" };
  state.mission!.target = { x: 0, y: 9 };
  const lost = playTurn(state, skips(state)); assert.ok(lost.ok);
  assert.equal(lost.state.outcome, "defeat_wipe");
  assert.deepEqual(lost.log.map(e => e.type), ["enemy", "outcome"]);
  const escape = structuredClone(state);
  escape.mission!.target = { x: 3, y: 2 };
  const plan = skips(escape); plan.items[0]!.moveTo = { ...escape.mission.target };
  const won = playTurn(escape, plan); assert.ok(won.ok);
  assert.equal(won.state.outcome, "victory");
  assert.deepEqual(won.log.map(e => e.type), ["move", "outcome"]);
});

test("duplicate deployment cells cannot masquerade as a valid rescue opening", () => {
  assert.throws(() => createMatch({ ...opts, deployment: true, mission: "rescue:v1", deployZone: [
    { x: 0, y: 9 }, { x: 0, y: 9 }, { x: 1, y: 9 },
  ] }), /rescue_unavailable/);
});
