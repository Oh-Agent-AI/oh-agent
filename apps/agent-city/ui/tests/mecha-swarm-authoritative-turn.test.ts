import assert from "node:assert/strict";
import test from "node:test";
import { createMatch, bossPrepare, playTurn, previewPlan, type ArenaPlan, type MatchState } from "../src/game/mecha/rules.ts";
import { createRoundPerformance, performanceFromLog } from "../src/game/mecha/performance.ts";
import { incomingDamage } from "../src/game/mecha/combat.ts";
import { swapEventSink, type TurnEvent } from "../src/game/mecha/board.ts";
import { refresh } from "../src/game/mecha/combat.ts";

const c = (x: number, y: number) => ({ x, y });
function battle(): MatchState {
  const s = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", monsterContent: { speciesId: "swarm_mantle", contentVersion: 1 },
    boss: c(4, 4), covers: [], buildings: [], raiders: [], mechs: [
      { id: "Assault", pos: c(4, 2) }, { id: "Gunner", pos: c(0, 9) }, { id: "Support", pos: c(1, 9) },
    ] });
  bossPrepare(s);
  return s;
}
function plan(s: MatchState, move: { x: number; y: number } | null = null): ArenaPlan {
  return { revision: s.revision, items: s.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id,
    moveTo: m.id === "Assault" ? move : null, action: { kind: "skip" } })) };
}
function play(s: MatchState, p = plan(s)) {
  const result = playTurn(s, p); assert.ok(result.ok, JSON.stringify(result)); return result;
}

test("real prepare binds fixed candidates; preview and actual use the same reprojected births", () => {
  const state = battle(), before = structuredClone(state), announced = state.boss.intent!;
  assert.equal(announced.skillId, "split_swarm");
  assert.equal(announced.swarm?.request.skillId, "split_swarm");
  assert.equal(announced.swarm?.request.skillId === "split_swarm" && announced.swarm.request.candidates.length, 8);
  assert.equal(incomingDamage(state, "Assault", c(4, 3)), 0);
  const p = plan(state, c(4, 3)), preview = previewPlan(state, p), actual = play(state, p);
  assert.ok(preview.ok);
  assert.deepEqual(actual.log, preview.log);
  assert.deepEqual(actual.presentationStages, preview.stages);
  assert.deepEqual(state, before);
  const projection = preview.monsterProjection?.swarmProjection;
  assert.ok(projection && projection.status === "reprojected" && projection.skillId === "split_swarm");
  assert.equal(projection.slots.find(s => s.cell.x === 4 && s.cell.y === 3)?.reason, "occupied");
  const births = actual.log.filter(e => e.type === "raider_spawn");
  assert.equal(births.length, 2);
  assert.deepEqual(births.map(e => e.unit.id), ["swarm:0", "swarm:1"]);
  assert.ok(births.every(e => !(e.unit.pos.x === 4 && e.unit.pos.y === 3)));
  assert.deepEqual(actual.state.swarm, { version: 1, nextSpawnId: 2, resolvedActions: ["split:1"] });
  assert.ok(actual.state.raiders.every(r => r.summon?.expiresAtRound === 3));
  assert.ok(!actual.log.some(e => e.type === "enemy" && e.actor.startsWith("swarm:")));
});

test("spawns cap at four before round boundary, then expiry precedes next prepare", () => {
  const one = play(battle()), two = play(one.state);
  const births = two.log.filter(e => e.type === "raider_spawn"), expired = two.log.filter(e => e.type === "raider_remove");
  assert.equal(births.length, 2); assert.equal(expired.length, 2);
  assert.deepEqual(births.map(e => e.unit.id), ["swarm:2", "swarm:3"]);
  assert.deepEqual(expired.map(e => [e.unit.id, e.reason]), [["swarm:0", "expired"], ["swarm:1", "expired"]]);
  assert.ok(births[1]!.sequence < expired[0]!.sequence);
  assert.deepEqual(two.state.raiders.map(r => r.id), ["swarm:2", "swarm:3"]);
  assert.equal(two.state.turn, 3);
  assert.deepEqual(two.state.swarm?.resolvedActions, ["split:1", "split:2"]);
});

test("lethal action produces health evidence before removal and victory before outcome event", () => {
  const s = play(battle()).state;
  const target = s.raiders[0]!;
  // Establish a legal direct action with a single remaining child and dead boss.
  s.boss.hp = 0; s.boss.intent = null;
  s.raiders = [target]; target.hp = 2;
  s.mechs.find(m => m.id === "Assault")!.pos = c(target.pos.x - 1, target.pos.y);
  const p = plan(s); p.items.find(i => i.mechId === "Assault")!.action = { kind: "melee", target: target.id };
  const preview = previewPlan(s, p), result = play(s, p); assert.ok(preview.ok);
  assert.deepEqual(preview.log, result.log);
  const act = result.log.find(e => e.type === "act" && e.target === target.id);
  const removed = result.log.find(e => e.type === "raider_remove");
  assert.ok(act && act.type === "act" && act.effects?.length && removed && removed.type === "raider_remove");
  assert.equal(removed.reason, "death"); assert.ok(act.effects[0]!.sequence! < removed.sequence);
  assert.ok(result.log.indexOf(removed) < result.log.findIndex(e => e.type === "outcome"));
  assert.equal(result.state.outcome, "victory"); assert.equal(result.state.raiders.length, 0);
});

test("death wins over expiry at a boundary and reconciliation happens before victory", () => {
  const s = play(battle()).state; s.boss.hp = 0; s.boss.intent = null;
  s.raiders[0]!.hp = 0; s.raiders[0]!.summon!.expiresAtRound = s.turn;
  s.raiders[1]!.summon!.expiresAtRound = s.turn;
  const log: TurnEvent[] = [], old = swapEventSink(log);
  try { refresh(s); } finally { swapEventSink(old); }
  assert.deepEqual(log.filter(e => e.type === "raider_remove").map(e => e.reason), ["death", "expired"]);
  assert.equal(s.outcome, "victory"); assert.equal(s.raiders.length, 0);
});

test("boss displacement never rebinds the announced candidate set", () => {
  const s = battle(), announced = structuredClone(s.boss.intent!.swarm);
  const p = plan(s, c(4, 3));
  p.items.find(i => i.mechId === "Assault")!.action = { kind: "melee", target: "boss" };
  const preview = previewPlan(s, p), result = play(s, p); assert.ok(preview.ok);
  assert.deepEqual(preview.log, result.log);
  assert.ok(result.log.some(e => e.type === "shove" && e.unit === "boss" && !e.hit));
  assert.deepEqual(preview.monsterProjection?.swarm, announced);
  const projection = preview.monsterProjection?.swarmProjection;
  assert.ok(projection && projection.status === "reprojected" && projection.skillId === "split_swarm");
  assert.equal(projection.slots.find(s => s.cell.x === 4 && s.cell.y === 3)?.reason, "out_of_range");
  const candidates = announced!.request.skillId === "split_swarm" ? announced!.request.candidates : [];
  for (const event of result.log) if (event.type === "raider_spawn") assert.ok(candidates.some(p => p.x === event.unit.pos.x && p.y === event.unit.pos.y));
});

test("protected one-cell corridor survives real prepare, preview and execution", () => {
  const s = battle(); s.phase = "enemy_prepare"; s.boss.intent = null;
  s.terrain = Array.from({ length: 10 }, () => Array(10).fill("water"));
  for (let x = 0; x < 10; x++) s.terrain[3]![x] = "land";
  for (const p of [c(4,4), c(5,4), c(4,5), c(5,5)]) s.terrain[p.y]![p.x] = "land";
  s.mechs[0]!.pos = c(0, 3); s.mechs[1]!.pos = c(1, 3); s.mechs[2]!.pos = c(2, 3);
  bossPrepare(s);
  const declared = s.boss.intent!.swarmProjection;
  assert.ok(declared && declared.status === "reprojected" && declared.skillId === "split_swarm");
  assert.equal(declared.slots.find(v => v.cell.x === 4 && v.cell.y === 3)?.reason, "protected_path");
  assert.equal(declared.slots.find(v => v.cell.x === 5 && v.cell.y === 3)?.reason, "protected_path");
  const preview = previewPlan(s, plan(s)), result = play(s); assert.ok(preview.ok);
  assert.deepEqual(preview.log, result.log);
  assert.equal(result.log.filter(e => e.type === "raider_spawn").length, 0);
  assert.deepEqual(result.state.swarm?.resolvedActions, ["split:1"]);
});

test("collision damage is logged before immediate death cleanup", () => {
  const s = play(battle()).state;
  // Place a surviving child in the square into which the boss will be pushed.
  s.raiders = [s.raiders[0]!]; s.raiders[0]!.pos = c(4, 6);
  s.mechs.find(m => m.id === "Assault")!.pos = c(4, 3);
  const p = plan(s); p.items.find(i => i.mechId === "Assault")!.action = { kind: "melee", target: "boss" };
  const result = play(s, p);
  const collision = result.log.find(e => e.type === "shove" && e.unit === "boss" && !!e.hit);
  const removal = result.log.find(e => e.type === "raider_remove" && e.unit.id === "swarm:0");
  assert.ok(collision && collision.type === "shove" && removal && removal.type === "raider_remove");
  const effect = collision.effects?.find(e => e.id === "swarm:0");
  assert.ok(effect); assert.equal(effect.after, 0); assert.ok(effect.sequence! < removal.sequence);
  assert.equal(removal.reason, "death");
});

test("actual lifecycle events reconcile with presentation stages", async () => {
  const { buildPresentationChanges } = await import("../src/game/mecha/presentationChanges.ts");
  let state = battle();
  for (let i = 0; i < 4 && !state.outcome; i++) {
    const result = play(state); assert.ok(result.presentationStages);
    const changes = buildPresentationChanges(result.presentationStages, result.log);
    assert.ok(changes.ok, JSON.stringify(changes));
    state = result.state;
  }
});

test("ledger and binding tampering are rejected without mutation", async () => {
  const { applyEnemyPlan, scriptedEnemyPlanner } = await import("../src/game/mecha/enemy/planner.ts");
  const s = battle(), bad = structuredClone(s);
  if (bad.boss.intent!.swarm?.request.skillId !== "split_swarm") throw new Error("missing split");
  bad.boss.intent!.swarm.request.hp = 200;
  const snapshot = structuredClone(bad);
  assert.throws(() => previewPlan(bad, plan(bad)), /unsupported_swarm_state/);
  assert.deepEqual(bad, snapshot);
  const invalid = structuredClone(s); invalid.swarm!.nextSpawnId = 2;
  assert.throws(() => playTurn(invalid, plan(invalid)), /unsupported_swarm_state/);
  const unprepared = battle(); unprepared.phase = "enemy_prepare"; unprepared.boss.intent = null;
  const prepared = scriptedEnemyPlanner.plan(unprepared);
  prepared.boss.anchor.x++;
  assert.equal(applyEnemyPlan(unprepared, prepared), false);
});

test("swarm rejects a planner that fabricates projections or moves raiders", async () => {
  const { applyEnemyPlan, scriptedEnemyPlanner } = await import("../src/game/mecha/enemy/planner.ts");
  const state = play(battle()).state;
  state.phase = "enemy_prepare"; state.boss.intent = null;
  const before = structuredClone(state);
  const forged = scriptedEnemyPlanner.plan(state);
  forged.boss.intent!.projected = [];
  assert.equal(applyEnemyPlan(state, forged), false);
  assert.deepEqual(state, before);
  const moved = scriptedEnemyPlanner.plan(state);
  moved.raiders[0]!.pos = c(0, 0);
  assert.equal(applyEnemyPlan(state, moved), false);
  assert.deepEqual(state, before);
});

test("full bounded match preserves preview parity and unique timed lifecycles", () => {
  let state = battle();
  for (const mech of state.mechs) mech.hp = 500;
  const born = new Map<string, number>(), removed = new Set<string>();
  for (let round = 1; round <= 15; round++) {
    assert.equal(state.turn, round);
    const p = plan(state), preview = previewPlan(state, p), actual = play(state, p);
    assert.ok(preview.ok);
    assert.deepEqual(preview.log, actual.log);
    assert.deepEqual(preview.stages, actual.presentationStages);
    for (const event of actual.log) {
      if (event.type === "raider_spawn") {
        assert.equal(born.has(event.unit.id), false);
        born.set(event.unit.id, round);
      } else if (event.type === "raider_remove") {
        assert.equal(removed.has(event.unit.id), false);
        assert.equal(event.reason, "expired");
        assert.equal(round + 1, born.get(event.unit.id)! + 2);
        removed.add(event.unit.id);
      }
    }
    assert.ok(actual.state.raiders.filter(r => r.summon).length <= 4);
    assert.ok(actual.state.swarm!.nextSpawnId <= 30);
    state = actual.state;
  }
  assert.equal(state.outcome, "defeat_timeout");
  assert.ok(born.size > 4);
  assert.equal(born.size, state.swarm!.nextSpawnId);
});

test("killing the boss does not win while children survive; expiry precedes victory", () => {
  const state = play(battle()).state;
  state.boss.hp = 1;
  state.mechs.find(m => m.id === "Assault")!.pos = c(3, 4);
  const p = plan(state);
  p.items.find(i => i.mechId === "Assault")!.action = { kind: "melee", target: "boss" };
  const preview = previewPlan(state, p), result = play(state, p);
  assert.ok(preview.ok); assert.deepEqual(preview.log, result.log);
  assert.equal(result.state.boss.hp, 0);
  assert.ok(result.log.some(e => e.type === "raider_remove" && e.reason === "expired"));
  assert.equal(result.state.outcome, "victory");
  assert.ok(result.log.findIndex(e => e.type === "raider_remove") < result.log.findIndex(e => e.type === "outcome"));
});

test("cap-four projection cannot create a fifth child", async () => {
  const { projectSwarm } = await import("../src/game/mecha/board.ts");
  const state = play(play(battle()).state).state;
  const reference = state.raiders[0]!;
  for (const [id, pos] of [["swarm:0", c(0, 0)], ["swarm:1", c(1, 0)]] as const) {
    state.raiders.push({ ...structuredClone(reference), id, pos, intent: null });
  }
  const projection = projectSwarm(state, state.boss.intent!).projection;
  assert.ok(projection.status === "reprojected" && projection.skillId === "split_swarm");
  assert.ok(projection.slots.some(slot => slot.reason === "summon_cap"));
  assert.ok(projection.slots.every(slot => slot.unit === null));
  const preview = previewPlan(state, plan(state)), result = play(state);
  assert.ok(preview.ok); assert.deepEqual(preview.log, result.log);
  assert.ok(!result.log.some(event => event.type === "raider_spawn"));
});


test("swarm declarations never become fabricated boss smashes in fallback or log playback", () => {
  const before = battle(), p = plan(before), result = play(before, p);
  assert.ok(result.state.raiders.length > 0);
  assert.ok(!createRoundPerformance(before, p, before, result.state, result.state).some(c => c.kind === "attack" && c.actor === "boss"));
  const fake: TurnEvent[] = [{ type: "enemy", actor: "boss", skill: "split_swarm", cells: [{ x: 4, y: 3 }], damage: 0 }];
  assert.ok(!performanceFromLog(before, result.state, fake).some(c => c.kind === "attack" && c.actor === "boss"));
});
