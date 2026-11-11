import assert from "node:assert/strict";
import test from "node:test";
import { swapEventSink, type TurnEvent } from "../src/game/mecha/board.ts";
import { applyEnemyPlan, scriptedEnemyPlanner } from "../src/game/mecha/enemy/planner.ts";
import { bossExecute } from "../src/game/mecha/enemy.ts";
import { buildHealthTimeline } from "../src/game/mecha/healthTimeline.ts";
import { performanceFromLog } from "../src/game/mecha/performance.ts";
import { performanceHealthSchedule } from "../src/game/mecha/performanceHealth.ts";
import { buildPresentationChanges } from "../src/game/mecha/presentationChanges.ts";
import { bossPrepare, createMatch, playTurn, previewPlan, type ArenaPlan, type MatchState } from "../src/game/mecha/rules.ts";

const c = (x: number, y: number) => ({ x, y });
function prepared(): MatchState {
  const s = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: c(4, 4),
    raiders: [{ id: "a", pos: c(3, 4) }, { id: "b", pos: c(6, 4) }],
    mechs: [{ id: "Assault", pos: c(2, 4) }, { id: "Gunner", pos: c(0, 9) }, { id: "Support", pos: c(1, 9) }],
    monsterContent: { speciesId: "neural_weaver", contentVersion: 1 } });
  bossPrepare(s); return s;
}
function hold(s: MatchState): ArenaPlan {
  return { revision: s.revision, items: s.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) };
}
function run(s: MatchState, plan = hold(s)) {
  const before = structuredClone(s), preview = previewPlan(s, plan), result = playTurn(s, plan);
  assert.ok(preview.ok && result.ok && result.presentationStages);
  assert.deepEqual(s, before); assert.deepEqual(preview.log, result.log);
  assert.deepEqual(playTurn(JSON.parse(JSON.stringify(s)), plan), result);
  const changes = buildPresentationChanges(result.presentationStages, result.log);
  assert.ok(changes.ok, JSON.stringify({ changes, log: result.log }));
  const health = buildHealthTimeline(s, result.state, result.log);
  assert.ok(health.ok, JSON.stringify(health));
  const cues = performanceFromLog(s, result.state, result.log, { presentationChanges: changes, healthTimeline: health });
  assert.ok(performanceHealthSchedule(cues, health, changes));
  const journal = result.state.neural!.journal.slice(s.neural!.journal.length);
  assert.deepEqual(result.log.filter(e => e.type === "neural_event").map(e => e.event), journal);
  assert.ok(!cues.some(cue => cue.kind === "attack" && cue.actor === "boss"));
  return { result, preview, changes, cues };
}

test("actual create is journal-backed, projected and visually cued before the linked raider's attack", () => {
  const s = prepared(), { result, changes, cues } = run(s);
  const index = result.log.findIndex(e => e.type === "neural_event" && e.event.type === "link_created");
  assert.ok(index >= 0);
  assert.deepEqual(changes.neuralCues, [{ eventIndex: index, change: "created", targetId: "raider:a" }]);
  const cue = cues.find(c => c.sourceLogIndex === index);
  assert.ok(cue?.kind === "neural_link"); assert.equal(cue.change, "created");
  assert.ok(cues.findIndex(c => c === cue) < cues.findIndex(c => c.kind === "attack" && c.actor === "a"));
  assert.ok(!performanceFromLog(s, result.state, result.log).some(c => c.kind === "neural_link"));
});

test("target death produces a void for the original target and no link cue", () => {
  const s = prepared(); s.raiders.find(r => r.id === "a")!.hp = 4;
  const plan = hold(s); plan.items[0]!.action = { kind: "melee", target: "a" };
  const { result, preview, cues } = run(s, plan);
  assert.deepEqual(preview.monsterProjection?.swarmProjection, { status: "void", reason: "target_dead" });
  assert.deepEqual(result.log.filter(e => e.type === "neural_event").map(e => e.event), [
    { type: "link_void", round: 1, actionId: "neural:1", targetId: "raider:a", reason: "target_dead" },
  ]);
  assert.ok(!cues.some(c => c.kind === "neural_link"));
});

test("expiration and terminal cleanup are recorded once and supported by journal snapshots", () => {
  let s = prepared();
  for (let i = 0; i < 3; i++) {
    const { result } = run(s); s = result.state;
  }
  assert.ok(s.neural!.journal.some(e => e.type === "link_broken" && e.reason === "expired"));
  const terminal = prepared(); terminal.turn = 15;
  // Re-prepare for the new round, without retaining the old binding.
  terminal.neural!.pending = null; terminal.boss.intent = null; terminal.phase = "enemy_prepare"; bossPrepare(terminal);
  const { result, cues } = run(terminal);
  assert.equal(result.state.outcome, "defeat_timeout");
  assert.deepEqual(result.log.filter(e => e.type === "neural_event").map(e => e.event.type), ["link_created", "link_broken"]);
  assert.equal(cues.filter(c => c.kind === "neural_link").length, 2);
});

test("speculative planning never emits journal effects; actual movement emits exactly once", () => {
  const s = prepared(); bossExecute(s);
  s.mechs[0]!.pos = c(0, 0); s.mechs[1]!.pos = c(0, 1); s.mechs[2]!.pos = c(1, 0);
  const log: TurnEvent[] = [], outer = swapEventSink(log);
  try {
    const plan = scriptedEnemyPlanner.plan(s);
    assert.deepEqual(log, []);
    assert.equal(applyEnemyPlan(s, plan), true);
    assert.deepEqual(log.filter(e => e.type === "neural_event").map(e => e.event), [s.neural!.journal.at(-1)]);
    assert.equal(s.neural!.journal.at(-1)?.type, "link_broken");
  } finally { swapEventSink(outer); }
});

test("missing, duplicate, reordered, forged and accessor evidence cannot yield verified link cues", () => {
  const s = prepared(), { result } = run(s), stages = result.presentationStages!;
  const index = result.log.findIndex(e => e.type === "neural_event"); assert.ok(index >= 0);
  for (const mutate of [
    (log: TurnEvent[]) => { log.splice(index, 1); },
    (log: TurnEvent[]) => { log.push(structuredClone(log[index]!)); },
    (log: TurnEvent[]) => { const e = log[index]!; if (e.type === "neural_event" && e.event.type === "link_created") e.event.link.targetId = "raider:b"; },
    (log: TurnEvent[]) => { const e = log[index]!; if (e.type === "neural_event" && e.event.type === "link_created") e.event.link.attackBonus++; },
  ]) {
    const log = structuredClone(result.log); mutate(log);
    const changes = buildPresentationChanges(stages, log);
    assert.equal(changes.ok, false);
    assert.ok(!performanceFromLog(s, result.state, log, { presentationChanges: changes }).some(c => c.kind === "neural_link"));
  }
  // Moving a journal entry across an ordinary attack preserves journal order but
  // must not move the visual cue relative to the attack.
  const reordered = structuredClone(result.log);
  const attackIndex = reordered.findIndex(e => e.type === "enemy" && e.actor === "a");
  assert.ok(attackIndex > index);
  const [entry] = reordered.splice(index, 1);
  reordered.splice(attackIndex, 0, entry!);
  assert.equal(buildPresentationChanges(stages, reordered).ok, false);
  const missingPositions = structuredClone(stages); delete missingPositions.neuralLogIndices;
  assert.equal(buildPresentationChanges(missingPositions, result.log).ok, false);
  const badPositions = structuredClone(stages); badPositions.neuralLogIndices![0]!++;
  assert.equal(buildPresentationChanges(badPositions, result.log).ok, false);
  let positionReads = 0;
  const accessorPositions = structuredClone(stages);
  Object.defineProperty(accessorPositions, "neuralLogIndices", { enumerable: true, get() { positionReads++; throw Error("getter"); } });
  assert.equal(buildPresentationChanges(accessorPositions, result.log).ok, false); assert.equal(positionReads, 0);
  const log = structuredClone(result.log); let reads = 0;
  Object.defineProperty(log[index]!, "event", { enumerable: true, get() { reads++; throw Error("getter"); } });
  assert.equal(buildPresentationChanges(stages, log).ok, false); assert.equal(reads, 0);
  const altered = structuredClone(stages); altered.afterEnemy.neural!.journal = [];
  assert.equal(buildPresentationChanges(altered, result.log).ok, false);
  const alteredLinks = structuredClone(stages); alteredLinks.afterEnemy.neural!.links = [];
  assert.equal(buildPresentationChanges(alteredLinks, result.log).ok, false);
  const inherited = structuredClone(stages); delete inherited.before.neural;
  Object.setPrototypeOf(inherited.before, { get neural() { reads++; throw Error("getter"); } });
  assert.equal(buildPresentationChanges(inherited, result.log).ok, false); assert.equal(reads, 0);
});

test("prepare-phase movement publishes only the authoritative break and does not invent a pre-move cue", () => {
  let s = prepared();
  s = run(s).result.state;
  assert.ok(s.neural!.links.some(link => link.targetId === "raider:a"));
  s.mechs[0]!.pos = c(0, 0); s.mechs[1]!.pos = c(0, 1); s.mechs[2]!.pos = c(1, 0);
  const { result, changes, cues } = run(s), stages = result.presentationStages!;
  const late = stages.afterPrepare.neural!.journal.slice(stages.afterEnemy.neural!.journal.length);
  assert.ok(late.some(e => e.type === "link_broken" && e.reason === "out_of_range"), JSON.stringify({ late, raiders: s.raiders, after: result.state.raiders }));
  for (const event of late) {
    const index = result.log.findIndex(e => e.type === "neural_event" && JSON.stringify(e.event) === JSON.stringify(event));
    assert.ok(index >= 0);
    assert.equal(result.log.filter(e => e.type === "neural_event" && JSON.stringify(e.event) === JSON.stringify(event)).length, 1);
    assert.ok(!changes.neuralCues?.some(c => c.eventIndex === index));
    assert.ok(!cues.some(c => c.kind === "neural_link" && c.sourceLogIndex === index));
  }
});


test("a boss shove that breaks range does not draw a beam at the stale boss position", () => {
  const s = run(prepared()).result.state;
  s.raiders.find(r => r.id === "a")!.pos = c(1, 4);
  s.mechs[0]!.pos = c(3, 4);
  const plan = hold(s); plan.items[0]!.action = { kind: "melee", target: "boss" };
  const { result, changes, cues } = run(s, plan);
  const index = result.log.findIndex(e => e.type === "neural_event" && e.event.type === "link_broken" && e.event.reason === "out_of_range");
  assert.ok(index >= 0, JSON.stringify(result.log));
  assert.ok(result.log.slice(index + 1).some(e => e.type === "shove" && e.unit === "boss" && !e.hit));
  assert.ok(!changes.neuralCues?.some(c => c.eventIndex === index));
  assert.ok(!cues.some(c => c.kind === "neural_link" && c.sourceLogIndex === index));
});
