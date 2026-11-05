import assert from "node:assert/strict";
import test from "node:test";
import { buildHealthTimeline } from "../src/game/mecha/healthTimeline.ts";
import { performanceFromLog } from "../src/game/mecha/performance.ts";
import { buildPresentationChanges } from "../src/game/mecha/presentationChanges.ts";
import { bossPrepare, createMatch, living, playTurn, type ArenaPlan } from "../src/game/mecha/rules.ts";

test("real spore leap presentation reconciles and moves before its attack and damage", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [],
    boss: { x: 4, y: 4 }, monsterContent: { speciesId: "spore_leaper", contentVersion: 1 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 5 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] });
  bossPrepare(state);
  const plan: ArenaPlan = { revision: state.revision, items: living(state).map(({ id }) => ({ mechId: id, moveTo: null, action: { kind: "skip" } })) };
  const result = playTurn(state, plan);
  assert.ok(result.ok);
  assert.ok(result.presentationStages);
  const changes = buildPresentationChanges(result.presentationStages, result.log);
  const health = buildHealthTimeline(state, result.state, result.log);
  assert.equal(changes.ok, true, JSON.stringify(changes));
  assert.equal(health.ok, true, JSON.stringify(health));
  const moveIndex = result.log.findIndex(event => event.type === "boss_move");
  const attackIndex = result.log.findIndex(event => event.type === "enemy" && event.actor === "boss");
  assert.ok(moveIndex >= 0 && attackIndex > moveIndex);
  const cues = performanceFromLog(state, result.state, result.log, { healthTimeline: health, presentationChanges: changes });
  const moveCue = cues.findIndex(cue => cue.kind === "move" && cue.actor === "boss" && cue.sourceLogIndex === moveIndex);
  const attackCue = cues.findIndex(cue => cue.kind === "attack" && cue.actor === "boss" && cue.sourceLogIndex === attackIndex);
  assert.ok(moveCue >= 0 && attackCue > moveCue, JSON.stringify(cues));
  const motion = cues[moveCue]!;
  assert.ok(motion.kind === "move");
  assert.deepEqual(motion.path[0], result.presentationStages.afterPlayer.boss.anchor);
  assert.deepEqual(motion.path.at(-1), result.presentationStages.afterEnemy.boss.anchor);
});
