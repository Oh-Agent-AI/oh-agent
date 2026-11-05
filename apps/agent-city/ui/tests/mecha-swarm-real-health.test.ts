import assert from "node:assert/strict";
import test from "node:test";
import { bossPrepare, createMatch, playTurn, type ArenaPlan, type MatchState } from "../src/game/mecha/rules.ts";
import { buildHealthTimeline } from "../src/game/mecha/healthTimeline.ts";

function skip(state: MatchState): ArenaPlan {
  return { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) };
}

test("authoritative swarm births and expiry reconcile the complete health timeline", () => {
  let state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", monsterContent: { speciesId: "swarm_mantle", contentVersion: 1 },
    boss: { x: 4, y: 4 }, covers: [], buildings: [], raiders: [], mechs: [
      { id: "Assault", pos: { x: 4, y: 2 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 1, y: 9 } },
    ] });
  bossPrepare(state);
  for (let turn = 0; turn < 3; turn++) {
    const result = playTurn(state, skip(state));
    assert.ok(result.ok, JSON.stringify(result));
    const timeline = buildHealthTimeline(state, result.state, result.log, result.presentationStages);
    assert.ok(timeline.ok, JSON.stringify({ turn, timeline, log: result.log }));
    assert.ok(timeline.steps.every(step => step.effect.before !== step.effect.after));
    state = result.state;
  }
});

test("verified births and expirations become ordered cues; missing evidence creates none", async () => {
  const { buildPresentationChanges } = await import("../src/game/mecha/presentationChanges.ts");
  const { performanceFromLog } = await import("../src/game/mecha/performance.ts");
  const { performanceHealthSchedule } = await import("../src/game/mecha/performanceHealth.ts");
  let state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", monsterContent: { speciesId: "swarm_mantle", contentVersion: 1 },
    boss: { x: 4, y: 4 }, covers: [], buildings: [], raiders: [], mechs: [
      { id: "Assault", pos: { x: 4, y: 2 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 1, y: 9 } },
    ] });
  bossPrepare(state);
  for (let i = 0; i < 2; i++) {
    const result = playTurn(state, skip(state)); assert.ok(result.ok); assert.ok(result.presentationStages);
    const timeline = buildHealthTimeline(state, result.state, result.log, result.presentationStages);
    const changes = buildPresentationChanges(result.presentationStages, result.log);
    assert.ok(timeline.ok); assert.ok(changes.ok, JSON.stringify(changes));
    const cues = performanceFromLog(state, result.state, result.log, { healthTimeline: timeline, presentationChanges: changes });
    const lifecycle = cues.filter(cue => cue.kind === "raider_spawn" || cue.kind === "raider_remove");
    assert.deepEqual(lifecycle.map(cue => [cue.kind, cue.actor]), result.log.flatMap(event =>
      event.type === "raider_spawn" || event.type === "raider_remove" ? [[event.type, event.unit.id]] : []));
    assert.ok(performanceHealthSchedule(cues, timeline, changes));
    const unsupported = performanceFromLog(state, result.state, result.log);
    assert.ok(!unsupported.some(cue => cue.kind === "raider_spawn" || cue.kind === "raider_remove"));
    state = result.state;
  }
});

test("lifecycle player keeps child hidden before spawn and after expiry, including pauses", async () => {
  const THREE = await import("three");
  const { MechaPerformancePlayer } = await import("../src/render/mecha/animation.ts");
  const child = new THREE.Group(), root = new THREE.Group(); root.add(child);
  const cues = [
    { kind: "raider_spawn" as const, actor: "swarm:0", at: { x: 2, y: 3 }, hp: 2, duration: 1 },
    { kind: "raider_remove" as const, actor: "swarm:0", at: { x: 2, y: 3 }, hp: 2, reason: "expired" as const, duration: 1 },
  ];
  let complete = 0;
  const player = new MechaPerformancePlayer({ "swarm:0": child }, cues, cell => new THREE.Vector3(cell.x, 0, cell.y), root, () => complete++);
  assert.equal(child.visible, false);
  player.update(0); assert.equal(child.visible, true);
  player.update(0.5); const pos = child.position.clone(); player.update(0);
  assert.deepEqual(child.position.toArray(), pos.toArray());
  player.update(0.5); assert.equal(child.visible, true);
  player.update(1); assert.equal(child.visible, false); assert.equal(complete, 1);
  player.dispose(); assert.equal(root.children.length, 1);
});
