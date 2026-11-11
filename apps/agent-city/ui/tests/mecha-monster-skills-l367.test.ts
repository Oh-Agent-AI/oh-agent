import assert from "node:assert/strict";
import test from "node:test";
import { createPlanScorer } from "../src/game/mecha/ai/score.ts";
import { rulePlanSimulator } from "../src/game/mecha/ai/simulate.ts";
import { STATS } from "../src/game/mecha/board.ts";
import { incomingDamage, reproject, tryTranslateBoss } from "../src/game/mecha/combat.ts";
import { bossPrepare, createMatch, playTurn, previewPlan, type ArenaPlan, type MatchState, type MonsterSpeciesId } from "../src/game/mecha/rules.ts";

function fixture(speciesId: MonsterSpeciesId, raider = false): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 }, covers: [],
    mechs: [{ id: "Assault", pos: { x: 4, y: 7 } }, { id: "Gunner", pos: { x: 4, y: 8 } }, { id: "Support", pos: { x: 0, y: 9 } }],
    raiders: raider ? [{ id: "r1", pos: { x: 9, y: 0 } }] : [], monsterContent: { speciesId, contentVersion: 1 } });
  bossPrepare(state);
  return state;
}
function hold(state: MatchState): ArenaPlan {
  return { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) };
}
function run(state: MatchState, plan = hold(state)) {
  const before = structuredClone(state);
  const preview = previewPlan(state, plan);
  const result = playTurn(state, plan);
  assert.ok(preview.ok); assert.ok(result.ok);
  assert.deepEqual(state, before);
  assert.deepEqual(preview.log, result.log);
  assert.deepEqual(preview.stages, result.presentationStages);
  assert.equal(preview.outcome, result.state.outcome);
  return result;
}

test("corrode creates a bound two-turn field, ticks, expires and forecasts true damage", () => {
  const state = fixture("porous_shaper");
  assert.deepEqual(state.boss.intent?.corrode?.target, { x: 4, y: 7 });
  assert.equal(incomingDamage(state, "Assault", { x: 4, y: 7 }), 1);
  const first = run(state);
  assert.equal(first.state.mechs[0]!.hp, 13);
  assert.deepEqual(first.log.map(e => e.type), ["corrode_field", "corrode_tick"]);
  assert.equal(first.state.corrode?.fields.length, 1);
  const second = run(first.state);
  assert.equal(second.state.mechs[0]!.hp, 12);
  assert.ok(second.log.some(e => e.type === "corrode_field" && e.change === "expired" && e.reason === "duration"));
  assert.equal(second.state.corrode?.fields.some(f => f.cell.x === 4 && f.cell.y === 7), false);
});

test("corrode does not retarget when its occupant moves; blocked bound cell voids", () => {
  const state = fixture("porous_shaper");
  const plan = hold(state); plan.items[0]!.moveTo = { x: 3, y: 7 };
  const moved = run(state, plan);
  assert.equal(moved.state.mechs[0]!.hp, 14);
  assert.deepEqual(moved.state.corrode?.fields[0]?.cell, { x: 4, y: 7 });
  const blocked = fixture("porous_shaper"); blocked.obstacles.push({ x: 4, y: 7 });
  reproject(blocked);
  assert.equal(blocked.boss.intent?.status, "void");
  const result = run(blocked);
  assert.ok(!result.log.some(e => e.type === "corrode_field" && e.change === "created"));
});

test("corrode survives dead caster while enemies remain, and clears at terminal", () => {
  const state = fixture("porous_shaper", true);
  const first = run(state);
  const next = first.state;
  next.boss.hp = 0; next.boss.intent = null;
  const second = run(next);
  assert.equal(second.state.mechs[0]!.hp, 12);
  assert.ok(second.log.some(e => e.type === "corrode_tick" && e.unit === "Assault"));
  const lethal = fixture("porous_shaper");
  lethal.mechs[0]!.hp = 1; lethal.mechs[1]!.hp = 0; lethal.mechs[2]!.hp = 0;
  const ended = run(lethal);
  assert.equal(ended.state.outcome, "defeat_wipe");
  assert.deepEqual(ended.state.corrode?.fields, []);
  assert.ok(ended.log.some(e => e.type === "corrode_field" && e.change === "expired" && e.reason === "finished"));
});

test("phase swap binds a unit, moves both atomically, then damages in sequence", () => {
  const state = fixture("phase_stalker");
  const intent = state.boss.intent!;
  assert.deepEqual(intent.displacement?.request.targetIds, ["mech:Gunner"]);
  const result = run(state);
  const move = result.log.find(e => e.type === "monster_displacement");
  const attack = result.log.find(e => e.type === "enemy" && e.skill === "phase_swap");
  assert.ok(move && move.type === "monster_displacement"); assert.ok(attack && attack.type === "enemy");
  assert.deepEqual(move.moves.map(m => m.unit), ["boss", "mech:Gunner"]);
  assert.deepEqual(result.state.boss.anchor, { x: 4, y: 8 });
  assert.deepEqual(result.state.mechs[1]!.pos, { x: 4, y: 4 });
  assert.ok(move.sequence! < attack.effects![0]!.sequence!);
});

test("phase swap reprojects the same moving target, or voids without a substitute", () => {
  const state = fixture("phase_stalker");
  const plan = hold(state); plan.items[1]!.moveTo = { x: 6, y: 8 };
  const moved = run(state, plan);
  assert.deepEqual(moved.state.boss.anchor, { x: 6, y: 8 });
  assert.deepEqual(moved.state.mechs[1]!.pos, { x: 4, y: 4 });
  const blocked = fixture("phase_stalker"); blocked.obstacles.push({ x: 5, y: 8 });
  reproject(blocked); assert.equal(blocked.boss.intent?.status, "void");
  const result = run(blocked);
  assert.ok(!result.log.some(e => e.type === "monster_displacement" || (e.type === "enemy" && e.actor === "boss")));
  const dead = fixture("phase_stalker"); dead.mechs[1]!.hp = 0;
  reproject(dead); assert.equal(dead.boss.intent?.status, "void");
  assert.ok(!run(dead).log.some(e => e.type === "monster_displacement"));
});

test("gravity well applies bound pulls in order with partial voids and attacks afterward", () => {
  const state = fixture("gravity_core");
  assert.deepEqual(state.boss.intent?.displacement?.request.targetIds, ["mech:Assault", "mech:Gunner", "mech:Support"]);
  assert.equal(state.boss.intent?.displacementProjection?.effects[2]?.status, "void");
  const result = run(state);
  const moves = result.log.filter(e => e.type === "monster_displacement");
  assert.deepEqual(moves.map(e => e.moves[0]!.unit), ["mech:Assault", "mech:Gunner"]);
  assert.deepEqual(result.state.mechs.map(m => m.pos), [{ x: 4, y: 6 }, { x: 4, y: 7 }, { x: 0, y: 9 }]);
  const attack = result.log.find(e => e.type === "enemy" && e.skill === "gravity_well");
  assert.ok(attack && attack.type === "enemy");
  assert.ok(moves[0]!.sequence! < moves[1]!.sequence! && moves[1]!.sequence! < attack.effects![0]!.sequence!);
});

test("gravity never reselects after boss shove or blocked pull", () => {
  const state = fixture("gravity_core");
  const binding = structuredClone(state.boss.intent!.displacement!.request.targetIds);
  assert.ok(tryTranslateBoss(state, { x: 1, y: 0 }));
  reproject(state);
  assert.deepEqual(state.boss.intent!.displacement!.request.targetIds, binding);
  const result = run(state);
  assert.deepEqual(result, playTurn(state, hold(state)));
  const blocked = fixture("gravity_core"); blocked.obstacles.push({ x: 4, y: 6 });
  reproject(blocked);
  assert.equal(blocked.boss.intent!.displacementProjection!.effects[0]!.status, "void");
  assert.ok(!run(blocked).log.some(e => e.type === "monster_displacement" && e.moves.some(m => m.unit === "mech:Assault")));
});

test("malformed new content and cross-species injected bindings are rejected", () => {
  for (const speciesId of ["porous_shaper", "phase_stalker", "gravity_core"] as const) {
    for (const invalid of [{ speciesId, contentVersion: 2 }, { speciesId, contentVersion: 1, extra: true }]) {
      assert.throws(() => createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", monsterContent: invalid as never }), /unsupported_monster_content/);
      const state = fixture(speciesId);
      (state as unknown as { monsterContent: unknown }).monsterContent = invalid;
      assert.throws(() => previewPlan(state, hold(state)), /unsupported_monster_content/);
    }
    const state = fixture(speciesId);
    state.boss.intent!.skillId = speciesId === "gravity_core" ? "phase_swap" : "gravity_well";
    assert.throws(() => playTurn(state, hold(state)), /unsupported_monster_content/);
  }
});

test("lethal gravity attack stops before damaging other bound victims", () => {
  const state = fixture("gravity_core");
  state.mechs[0]!.hp = 1;
  state.mechs[1]!.hp = 0;
  state.mechs[2]!.hp = 0;
  const result = run(state);
  assert.equal(result.state.outcome, "defeat_wipe");
  const attack = result.log.find(e => e.type === "enemy" && e.skill === "gravity_well");
  assert.ok(attack && attack.type === "enemy");
  assert.deepEqual(attack.effects?.map(effect => effect.id), ["Assault"]);
});

test("corrode timeout clears retained fields after the final tick", () => {
  const state = fixture("porous_shaper");
  state.turn = 15;
  state.corrode!.nextRound = 15;
  state.boss.intent!.corrode!.preparedRound = 15;
  const result = run(state);
  assert.equal(result.state.outcome, "defeat_timeout");
  assert.deepEqual(result.state.corrode?.fields, []);
  const fieldEvents = result.log.filter(e => e.type === "corrode_field");
  assert.deepEqual(fieldEvents.map(e => [e.change, e.reason]), [["created", undefined], ["expired", "finished"]]);
});

test("a real player shove reprojects gravity before the enemy executes", () => {
  const state = fixture("gravity_core");
  const plan = hold(state);
  plan.items[0]!.moveTo = { x: 4, y: 6 };
  plan.items[0]!.action = { kind: "melee", target: "boss" };
  const result = run(state, plan);
  const shove = result.log.find(e => e.type === "shove" && e.unit === "boss");
  const pulled = result.log.find(e => e.type === "monster_displacement" && e.moves[0]?.unit === "mech:Assault");
  assert.ok(shove && shove.type === "shove"); assert.ok(pulled && pulled.type === "monster_displacement");
  assert.ok(shove.sequence! < pulled.sequence!);
  assert.deepEqual(result.state.boss.anchor, { x: 4, y: 3 });
  assert.deepEqual(pulled.moves[0]!.to, { x: 4, y: 5 });
});

test("a lingering corrode field damages a raider that enters it", () => {
  const state = fixture("porous_shaper", true);
  const escape = hold(state); escape.items[0]!.moveTo = { x: 3, y: 7 };
  const first = run(state, escape);
  const next = first.state;
  next.raiders[0]!.pos = { x: 4, y: 7 };
  next.raiders[0]!.intent = null;
  const hp = next.raiders[0]!.hp;
  const second = run(next);
  assert.equal(second.state.raiders[0]!.hp, hp - 1);
  assert.ok(second.log.some(e => e.type === "corrode_tick" && e.unit === "r1"));
});

test("preview exposes post-player bound projections and committed effects, not next-turn intent", () => {
  const phase = fixture("phase_stalker");
  const phasePlan = hold(phase); phasePlan.items[1]!.moveTo = { x: 6, y: 8 };
  const projected = previewPlan(phase, phasePlan);
  assert.ok(projected.ok && projected.monsterProjection);
  assert.deepEqual(projected.monsterProjection.displacement!.request.targetIds, phase.boss.intent!.displacement!.request.targetIds);
  assert.deepEqual(projected.monsterProjection.displacementProjection!.effects.map(e => e.to), [{ x: 6, y: 8 }, { x: 4, y: 4 }]);
  const phaseTurn = playTurn(phase, phasePlan); assert.ok(phaseTurn.ok);
  const swap = phaseTurn.log.find(e => e.type === "monster_displacement"); assert.ok(swap && swap.type === "monster_displacement");
  assert.deepEqual(swap.moves.map(m => m.to), projected.monsterProjection.displacementProjection!.effects.map(e => e.to));
  const gravity = fixture("gravity_core"); gravity.obstacles.push({ x: 4, y: 6 });
  const gravityPreview = previewPlan(gravity, hold(gravity)); assert.ok(gravityPreview.ok && gravityPreview.monsterProjection);
  const effects = gravityPreview.monsterProjection.displacementProjection!.effects;
  assert.equal(effects[0]!.status, "void"); assert.equal(effects[0]!.reason, "obstacle");
  const gravityTurn = playTurn(gravity, hold(gravity)); assert.ok(gravityTurn.ok);
  const actual = gravityTurn.log.filter(e => e.type === "monster_displacement").flatMap(e => e.moves);
  assert.deepEqual(actual.map(m => [m.unit, m.to]), effects.filter(e => e.status === "move").map(e => [e.entityId, e.to]));
  const corrode = fixture("porous_shaper"); corrode.obstacles.push({ x: 4, y: 7 });
  const hazard = previewPlan(corrode, hold(corrode)); assert.ok(hazard.ok && hazard.monsterProjection);
  assert.equal(hazard.monsterProjection.corrode!.reason, "blocked");
  assert.deepEqual(hazard.monsterProjection.corrode!.target, { x: 4, y: 7 });
  assert.ok(!hazard.log.some(e => e.type === "corrode_field" && e.change === "created"));
});


test("AI scores current simulated damage and forced positions, plus avoidable residual corrode exposure", () => {
  const corrode = fixture("porous_shaper");
  const held = hold(corrode);
  const escape = hold(corrode); escape.items[0]!.moveTo = { x: 3, y: 7 };
  for (const doctrine of ["tunnel", "peel"] as const) {
    const scorer = createPlanScorer(doctrine);
    const exposure = scorer.score(corrode, held); const safe = scorer.score(corrode, escape);
    assert.ok(exposure && safe);
    assert.deepEqual(exposure.factors.find(f => f.id === "threat"), {
      id: "threat", value: 1, weight: -1, score: -1, note: "remaining corrode exposure; avoidable next round",
    });
    assert.equal(safe.factors.some(f => f.id === "threat"), false);
    assert.equal(exposure.factors.find(f => f.id === "mech_damage")!.value, 1);
  }
  for (const species of ["phase_stalker", "gravity_core"] as const) {
    const state = fixture(species); const plan = hold(state);
    const simulated = rulePlanSimulator.apply(state, plan); assert.ok(simulated);
    const score = createPlanScorer("tunnel").score(state, plan); assert.ok(score);
    const healthLoss = simulated.mechs.reduce((sum, mech) => sum + (STATS[mech.id].maxHp - mech.hp), 0);
    assert.equal(score.factors.find(f => f.id === "mech_damage")!.value, healthLoss);
    const center = { x: simulated.boss.anchor.x + 1, y: simulated.boss.anchor.y + 1 };
    const position = simulated.mechs.filter(mech => mech.hp > 0).reduce((sum, mech) => sum +
      Math.abs(mech.pos.x + 0.5 - center.x) + Math.abs(mech.pos.y + 0.5 - center.y), 0);
    assert.equal(score.factors.find(f => f.id === "position")!.value, position);
    assert.ok(simulated.mechs.some((mech, index) => JSON.stringify(mech.pos) !== JSON.stringify(state.mechs[index]!.pos)), `${species}: fixture must actually displace`);
  }
});

test("preview does not invent a reprojection when the player ends the match first", () => {
  for (const species of ["porous_shaper", "phase_stalker", "gravity_core"] as const) {
    const state = fixture(species); state.boss.hp = 1;
    const plan = hold(state);
    plan.items[0]!.moveTo = { x: 4, y: 6 };
    plan.items[0]!.action = { kind: "melee" };
    const projected = previewPlan(state, plan); const result = playTurn(state, plan);
    assert.ok(projected.ok && result.ok);
    assert.equal(projected.outcome, "victory");
    assert.equal(projected.monsterProjection, null);
    assert.deepEqual(projected.log, result.log);
    assert.deepEqual(projected.stages, result.presentationStages);
    assert.ok(!result.log.some(e => e.type === "monster_displacement" || (e.type === "corrode_field" && e.change === "created")));
  }
});
