import assert from "node:assert/strict";
import test from "node:test";
import { buildHealthTimeline } from "../src/game/mecha/healthTimeline.ts";
import { createRoundPerformance, performanceFromLog } from "../src/game/mecha/performance.ts";
import { performanceHealthSchedule } from "../src/game/mecha/performanceHealth.ts";
import { buildPresentationChanges } from "../src/game/mecha/presentationChanges.ts";
import { bossPrepare, createMatch, living, playTurn, type ArenaPlan, type MatchState, type MonsterSpeciesId } from "../src/game/mecha/rules.ts";

function fixture(speciesId: MonsterSpeciesId): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 4 },
    mechs: [{ id: "Assault", pos: { x: 4, y: 7 } }, { id: "Gunner", pos: { x: 4, y: 8 } }, { id: "Support", pos: { x: 0, y: 9 } }],
    monsterContent: { speciesId, contentVersion: 1 } });
  bossPrepare(state); return state;
}
function turn(state: MatchState) {
  const plan: ArenaPlan = { revision: state.revision, items: living(state).map(({ id }) => ({ mechId: id, moveTo: null, action: { kind: "skip" } })) };
  const result = playTurn(state, plan);
  assert.ok(result.ok); assert.ok(result.presentationStages);
  const changes = buildPresentationChanges(result.presentationStages, result.log);
  const health = buildHealthTimeline(state, result.state, result.log);
  assert.ok(changes.ok, JSON.stringify({ species: state.monsterContent, log: result.log, changes }));
  assert.ok(health.ok, JSON.stringify(health));
  const cues = performanceFromLog(state, result.state, result.log, { presentationChanges: changes, healthTimeline: health });
  assert.ok(performanceHealthSchedule(cues, health, changes), JSON.stringify({ log: result.log, cues, changes, health }));
  return { result, changes, health, cues };
}

test("real phase and gravity displacements have verified, grouped cues before their subsequent attack", () => {
  for (const species of ["phase_stalker", "gravity_core"] as const) {
    const state = fixture(species), { result, cues } = turn(state);
    const indexes = result.log.flatMap((event, index) => event.type === "monster_displacement" ? [index] : []);
    assert.ok(indexes.length, JSON.stringify({ species, log: result.log }));
    for (const index of indexes) {
      const event = result.log[index]!;
      assert.ok(event.type === "monster_displacement");
      const cue = cues.find(c => c.sourceLogIndex === index);
      assert.ok(cue?.kind === "monster_displacement");
      assert.equal(cue.skill, event.skill);
      assert.deepEqual(cue.moves.map(m => [m.actor, m.from, m.to]), event.moves.map(m => [m.unit.replace(/^mech:/, ""), m.from, m.to]));
      if (species === "phase_stalker") assert.equal(cue.moves.length, 2);
    }
    const attack = cues.findIndex(c => c.kind === "attack" && c.actor === "boss");
    assert.ok(attack > cues.findIndex(c => c.kind === "monster_displacement"));
    assert.equal((cues[attack] as Extract<typeof cues[number], {kind:"attack"}>).attack, "pierce");
    const bad = structuredClone(result.log);
    const displacement = bad[indexes[0]!]!;
    assert.ok(displacement.type === "monster_displacement");
    displacement.moves[0]!.from.x++;
    assert.equal(buildPresentationChanges(result.presentationStages!, bad).ok, false);
    delete displacement.sequence;
    assert.equal(buildPresentationChanges(result.presentationStages!, bad).ok, false);
  }
});

test("real corrode fields and ticks reconcile over turns with distinct, causally scheduled cues", () => {
  let state = fixture("porous_shaper"), ticks = 0, creates = 0, expires = 0;
  for (let i = 0; i < 4 && !state.outcome; i++) {
    const { result, cues, changes, health } = turn(state);
    const schedule = performanceHealthSchedule(cues, health, changes)!;
    for (const [index, event] of result.log.entries()) {
      if (event.type === "corrode_field") {
        const cue = cues.find(c => c.sourceLogIndex === index);
        assert.ok(cue?.kind === "corrode_field");
        assert.deepEqual(cue.cell, event.field.cell);
        if (event.change === "created") creates++; else expires++;
      } else if (event.type === "corrode_tick") {
        ticks++;
        const cueIndex = cues.findIndex(c => c.sourceLogIndex === index && c.kind === "corrode_tick");
        assert.ok(cueIndex >= 0);
        assert.deepEqual(schedule[cueIndex], event.effects);
      }
    }
    state = result.state;
  }
  assert.ok(creates && ticks && expires, JSON.stringify({ creates, ticks, expires }));
});

test("corrode evidence rejects invented fields, ticks, damage and missing sequence", () => {
  const state = fixture("porous_shaper"), { result } = turn(state);
  const stages = result.presentationStages!;
  const fieldIndex = result.log.findIndex(e => e.type === "corrode_field" && e.change === "created");
  const tickIndex = result.log.findIndex(e => e.type === "corrode_tick");
  assert.ok(fieldIndex >= 0 && tickIndex >= 0);
  const missingField = structuredClone(result.log); missingField.splice(fieldIndex, 1);
  assert.equal(buildPresentationChanges(stages, missingField).ok, false);
  const badTick = structuredClone(result.log); const tick = badTick[tickIndex]!;
  assert.ok(tick.type === "corrode_tick");
  tick.fieldId = "invented";
  assert.equal(buildPresentationChanges(stages, badTick).ok, false);
  tick.fieldId = (result.log[tickIndex] as typeof tick).fieldId; tick.damage++;
  assert.equal(buildPresentationChanges(stages, badTick).ok, false);
  const badField = structuredClone(result.log); const field = badField[fieldIndex]!;
  assert.ok(field.type === "corrode_field"); delete field.sequence;
  assert.equal(buildPresentationChanges(stages, badField).ok, false);
  const badEnd = structuredClone(stages); badEnd.afterEnemy.corrode!.fields = [];
  assert.equal(buildPresentationChanges(badEnd, result.log).ok, false);
});

test("unverified displacement never becomes a fabricated ordinary move or attack", () => {
  const state = fixture("phase_stalker"), { result, health } = turn(state);
  const cues = performanceFromLog(state, result.state, result.log, { presentationChanges: { ok: false, reason: "missing" }, healthTimeline: health });
  assert.ok(!cues.some(c => c.kind === "monster_displacement"));
  assert.ok(!cues.some(c => c.kind === "attack" && c.actor === "boss"));
  assert.ok(!cues.some(c => (c.kind === "move" || c.kind === "knockback") && (c.actor === "boss" || c.actor === "Assault")));
});

test("lethal corrode damage schedules defeat on its tick and expires fields on finish", () => {
  const state = fixture("porous_shaper");
  state.mechs[0]!.hp = 1; state.mechs[1]!.hp = 0; state.mechs[2]!.hp = 0;
  bossPrepare(state);
  const { result, cues, changes, health } = turn(state);
  assert.equal(result.state.outcome, "defeat_wipe");
  const tick = cues.findIndex(c => c.kind === "corrode_tick" && c.actor === "Assault");
  const death = cues.findIndex(c => c.kind === "death" && c.actor === "Assault");
  const expired = cues.findIndex(c => c.kind === "corrode_field" && c.change === "expired");
  assert.ok(tick >= 0 && death === tick + 1 && expired > death, JSON.stringify({ log: result.log, cues }));
  assert.equal(performanceHealthSchedule(cues, health, changes)![tick]![0]!.after, 0);
});


test("snapshot-only fallback does not invent attacks or displacement for new skills", () => {
  for (const species of ["porous_shaper", "phase_stalker", "gravity_core"] as const) {
    const state = fixture(species), { result } = turn(state);
    const plan: ArenaPlan = { revision: state.revision, items: living(state).map(({ id }) => ({ mechId: id, moveTo: null, action: { kind: "skip" } })) };
    const cues = createRoundPerformance(state, plan, state, result.state, result.state);
    assert.ok(!cues.some(c => c.kind === "attack" && c.actor === "boss"), JSON.stringify(cues));
    assert.ok(!cues.some(c => c.kind === "knockback" || c.kind === "monster_displacement"), JSON.stringify(cues));
  }
});

test("gravity well preserves the committed order of multiple one-unit pulls", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 4 },
    mechs: [{ id: "Assault", pos: { x: 2, y: 4 } }, { id: "Gunner", pos: { x: 7, y: 4 } }, { id: "Support", pos: { x: 4, y: 7 } }],
    monsterContent: { speciesId: "gravity_core", contentVersion: 1 } });
  bossPrepare(state);
  const { result, cues } = turn(state);
  const moves = result.log.filter(event => event.type === "monster_displacement");
  const played = cues.filter(cue => cue.kind === "monster_displacement");
  assert.equal(moves.length, 3); assert.equal(played.length, 3);
  assert.deepEqual(played.map(c => c.moves[0]!.actor), moves.map(e => e.moves[0]!.unit.replace(/^mech:/, "")));
  assert.ok(played.every(c => c.moves.length === 1 && c.skill === "gravity_well"));
});

test("a lethal player attack removes existing corrode fields after the attack, not before it", () => {
  const first = turn(fixture("porous_shaper")).result.state;
  assert.ok(first.corrode?.fields.length);
  first.boss.hp = 1;
  first.mechs.find(m => m.id === "Assault")!.pos = { x: 0, y: 0 };
  const plan: ArenaPlan = { revision: first.revision, items: living(first).map(({ id }) => ({ mechId: id, moveTo: null,
    action: id === "Gunner" ? { kind: "shoot", target: "boss" } : { kind: "skip" } })) };
  const result = playTurn(first, plan); assert.ok(result.ok); assert.ok(result.presentationStages);
  assert.equal(result.state.outcome, "victory");
  const changes = buildPresentationChanges(result.presentationStages, result.log);
  const health = buildHealthTimeline(first, result.state, result.log);
  assert.ok(changes.ok, JSON.stringify({ log: result.log, changes })); assert.ok(health.ok);
  const cues = performanceFromLog(first, result.state, result.log, { presentationChanges: changes, healthTimeline: health });
  const hit = cues.findIndex(c => c.kind === "attack" && c.actor === "Gunner");
  const expire = cues.findIndex(c => c.kind === "corrode_field" && c.change === "expired");
  assert.ok(hit >= 0 && expire > hit, JSON.stringify(cues));
});

test("missing displacement evidence never turns a snapshot difference into an ordinary move", () => {
  const state = fixture("phase_stalker"), { result, health } = turn(state);
  const missing = result.log.filter(event => event.type !== "monster_displacement");
  const changes = buildPresentationChanges(result.presentationStages!, missing);
  assert.equal(changes.ok, false);
  const cues = performanceFromLog(state, result.state, missing, { presentationChanges: changes, healthTimeline: health });
  assert.ok(!cues.some(c => c.kind === "monster_displacement" || c.kind === "move" || c.kind === "knockback"), JSON.stringify(cues));
  assert.ok(!cues.some(c => c.kind === "attack" && c.actor === "boss"));
});

test("cued special events cannot be reordered independently of their committed sequences", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 4 },
    mechs: [{ id: "Assault", pos: { x: 2, y: 4 } }, { id: "Gunner", pos: { x: 7, y: 4 } }, { id: "Support", pos: { x: 4, y: 7 } }],
    monsterContent: { speciesId: "gravity_core", contentVersion: 1 } });
  bossPrepare(state);
  const { result } = turn(state);
  const indexes = result.log.flatMap((event, i) => event.type === "monster_displacement" ? [i] : []);
  assert.ok(indexes.length >= 2);
  const reordered = structuredClone(result.log);
  [reordered[indexes[0]!]!, reordered[indexes[1]!]!] = [reordered[indexes[1]!]!, reordered[indexes[0]!]!];
  assert.equal(buildPresentationChanges(result.presentationStages!, reordered).ok, false);

  const corrode = turn(fixture("porous_shaper")).result;
  const field = corrode.log.findIndex(event => event.type === "corrode_field" && event.change === "created");
  const tick = corrode.log.findIndex(event => event.type === "corrode_tick");
  assert.ok(field >= 0 && tick > field);
  const reorderedCorrode = structuredClone(corrode.log);
  [reorderedCorrode[field]!, reorderedCorrode[tick]!] = [reorderedCorrode[tick]!, reorderedCorrode[field]!];
  assert.equal(buildPresentationChanges(corrode.presentationStages!, reorderedCorrode).ok, false);
});
