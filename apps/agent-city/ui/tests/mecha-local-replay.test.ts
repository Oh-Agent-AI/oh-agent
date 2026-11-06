import assert from "node:assert/strict";
import test from "node:test";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { performanceFromLog } from "../src/game/mecha/performance.ts";
import { bossPrepare, createMatch, living, playTurn, type MatchState, type TurnEvent } from "../src/game/mecha/rules.ts";

test("accepted local turns replay in order without changing authoritative match or log", () => {
  const controller = createMechaController({ animate: false });
  const rounds: { before: MatchState; after: MatchState; log: TurnEvent[] }[] = [];
  controller.startAuto();
  for (let i = 0; i < 100 && !controller.getState().match.outcome; i++) {
    const before = structuredClone(controller.getState().match);
    controller.tick();
    const state = controller.getState();
    if (state.match.revision !== before.revision) rounds.push({ before, after: structuredClone(state.match), log: structuredClone(state.lastLog) });
  }
  const final = controller.getState();
  assert.ok(final.match.outcome);
  assert.ok(rounds.length >= 2);
  assert.equal(final.replayAvailable, rounds.length);
  const finalMatch = structuredClone(final.match);
  const finalLog = structuredClone(final.lastLog);
  const finalCombat = structuredClone(final.combat);
  controller.startReplay();
  let previousId = final.combat.id;
  for (const [index, round] of rounds.entries()) {
    const replay = controller.getState();
    assert.equal(replay.replay?.index, index);
    assert.equal(replay.replay?.total, rounds.length);
    assert.equal(replay.replay?.turn, round.before.turn);
    assert.deepEqual(replay.replay?.log, round.log, "recap must use the selected recorded turn");
    assert.deepEqual(replay.replay?.after, round.after, "recap must use the selected turn's result");
    if (replay.replay?.combat.healthTimeline?.ok) for (const step of replay.replay.combat.healthTimeline.steps) {
      assert.equal(step.event, replay.replay.log[step.eventIndex], "timeline and recap must share the same event");
    }
    assert.deepEqual(replay.performance?.before, round.before);
    assert.deepEqual(replay.performance?.events, performanceFromLog(round.before, round.after, round.log, replay.replay!.combat));
    assert.ok(replay.replay!.combat.id > previousId);
    previousId = replay.replay!.combat.id;
    assert.deepEqual(replay.match, finalMatch);
    assert.deepEqual(replay.lastLog, finalLog);
    assert.deepEqual(replay.combat, finalCombat);
    controller.submit();
    controller.tick();
    assert.deepEqual(controller.getState().match, finalMatch);
    controller.finishPerformance();
  }
  assert.equal(controller.getState().replay, null);
  assert.equal(controller.getState().performance, null);
  assert.deepEqual(controller.getState().match, finalMatch);
  controller.startReplay();
  controller.getState().replay!.log.length = 0;
  controller.getState().replay!.after.turn = -1;
  controller.selectReplayTurn(0);
  assert.deepEqual(controller.getState().replay!.log, rounds[0]!.log, "recap cannot alter the recording");
  assert.deepEqual(controller.getState().replay!.after, rounds[0]!.after);
  controller.pause();
  controller.selectReplayTurn(rounds.length - 1);
  assert.equal(controller.getState().paused, true);
  assert.equal(controller.getState().replay?.index, rounds.length - 1);
  const replayId = controller.getState().replay!.combat.id;
  const previousPerformance = controller.getState().performance;
  controller.selectReplayTurn(rounds.length - 1);
  assert.ok(controller.getState().replay!.combat.id > replayId, "restarting a turn gives the animation a new cue");
  assert.notEqual(controller.getState().performance, previousPerformance);
  assert.deepEqual(controller.getState().performance?.before, rounds.at(-1)!.before);
  assert.equal(controller.getState().paused, true, "restarting preserves pause");
  assert.deepEqual(controller.getState().match, finalMatch);
  assert.deepEqual(controller.getState().lastLog, finalLog);
  controller.selectReplayTurn(-1);
  assert.equal(controller.getState().replay?.index, rounds.length - 1);
  controller.stopReplay();
  assert.equal(controller.getState().paused, false);
  assert.deepEqual(controller.getState().match, finalMatch);
  controller.restart();
  assert.equal(controller.getState().replayAvailable, 0);
  controller.startReplay();
  assert.equal(controller.getState().replay, null);
});

test("rejected plans and premature replay do not create recordings", () => {
  const controller = createMechaController({ planner: state => ({ revision: state.revision - 1, items: [] }), animate: false });
  controller.startReplay();
  assert.equal(controller.getState().replay, null);
  controller.startAuto();
  controller.tick();
  controller.tick();
  assert.ok(controller.getState().fault);
  assert.equal(controller.getState().replayAvailable, 0);
  assert.equal(controller.getState().performance, null);
});


test("a successful turn with no animation is still recorded", () => {
  const match = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], raiders: [] });
  match.turn = 15;
  bossPrepare(match);
  match.boss.intent = { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "planned" };
  const controller = createMechaController({ match, animate: true });
  for (const mech of living(match)) { controller.setMove(mech.id, null); controller.setAction(mech.id, { kind: "skip" }); }
  controller.submit();
  if (controller.getState().holdConfirmation) controller.confirmHold();
  assert.equal(controller.getState().match.outcome, "defeat_timeout");
  assert.equal(controller.getState().performance, null);
  assert.equal(controller.getState().replayAvailable, 1);
  controller.startReplay();
  assert.deepEqual(controller.getState().performance?.events, []);
  assert.equal(controller.getState().replay?.turn, 15);
  controller.finishPerformance();
  assert.equal(controller.getState().replay, null);
});

test("recorded real rounds reconcile displayed cue health with authoritative results", async () => {
  const { healthSnapshot } = await import("../src/game/mecha/board.ts");
  const { healthKey, performanceHealthSchedule } = await import("../src/game/mecha/performanceHealth.ts");
  const controller = createMechaController({ animate: false });
  const rounds: { before: MatchState; after: MatchState }[] = [];
  controller.startAuto();
  for (let i = 0; i < 100 && !controller.getState().match.outcome; i++) {
    const before = structuredClone(controller.getState().match);
    controller.tick();
    const after = controller.getState().match;
    if (before.revision !== after.revision) rounds.push({ before, after: structuredClone(after) });
  }
  assert.ok(rounds.length >= 2);
  controller.startReplay();
  let effectCount = 0;
  for (const round of rounds) {
    const state = controller.getState();
    const schedule = performanceHealthSchedule(state.performance!.events, state.replay!.combat.healthTimeline, state.replay!.combat.presentationChanges);
    assert.ok(schedule, `round ${round.before.turn} has a validated presentation schedule`);
    const values = new Map(healthSnapshot(round.before).map((v) => [healthKey(v.kind, v.id), v.after]));
    for (const effects of schedule) for (const effect of effects) {
      const key = healthKey(effect.kind, effect.id);
      assert.equal(values.get(key), effect.before);
      values.set(key, effect.after);
      effectCount++;
    }
    assert.deepEqual(values, new Map(healthSnapshot(round.after).map((v) => [healthKey(v.kind, v.id), v.after])));
    controller.finishPerformance();
  }
  assert.ok(effectCount > 0, "real match includes health changes");
});

test("nested enemy effects do not get shown before an intervening shove", async () => {
  const { performanceHealthSchedule } = await import("../src/game/mecha/performanceHealth.ts");
  const events = [
    { kind: "attack" as const, actor: "boss", attack: "smash" as const, from: {x:0,y:0}, target: {x:1,y:0}, targetIds: ["Assault"], duration: 1, sourceLogIndex: 1 },
    { kind: "knockback" as const, actor: "Assault", path: [{x:1,y:0},{x:2,y:0}], duration: 1, sourceLogIndex: 2 },
  ];
  const first = { kind: "mech" as const, id: "Assault", before: 6, after: 4, order: 0, sequence: 0 };
  const second = { kind: "building" as const, id: "b", before: 10, after: 5, order: 1, sequence: 2 };
  const enemy = { type: "enemy" as const, actor: "boss", skill: "smash" as const, cells: [], damage: 7, effects: [first, second] };
  const timeline = { ok: true as const, steps: [{ eventIndex: 1, event: enemy, effect: first }, { eventIndex: 1, event: enemy, effect: second }] };
  const changes = { ok: true as const, changes: [
    { sequence: 0, eventIndex: 1, kind: "health" as const, effect: first },
    { sequence: 1, eventIndex: 2, kind: "shove" as const, unit: "Assault", dir: {x:1,y:0} },
    { sequence: 2, eventIndex: 1, kind: "health" as const, effect: second },
  ] };
  assert.deepEqual(performanceHealthSchedule(events, timeline, changes), [[first], [second]]);
  assert.equal(performanceHealthSchedule(events, { ok: false, reason: "incomplete" }, changes), null);
  assert.equal(performanceHealthSchedule(events, timeline, { ok: false, reason: "incomplete" }), null);
  assert.equal(performanceHealthSchedule(events.map(({sourceLogIndex: _, ...e}) => e), timeline, changes), null);
});

test("verified defeats follow the lethal cue at the actor's current position", async () => {
  const { performanceHealthSchedule } = await import("../src/game/mecha/performanceHealth.ts");
  const scenarios = [
    { script: "siege", doctrine: "tunnel" },
    { script: "cadence_ssw", doctrine: "peel" },
    { script: "stationary_smash", doctrine: "tunnel" },
  ] as const;
  let defeats = 0, earlyDefeats = 0;
  for (const scenario of scenarios) {
    const controller = createMechaController({ ...scenario, animate: false });
    const rounds: MatchState[] = [];
    controller.startAuto();
    for (let i = 0; i < 120 && !controller.getState().match.outcome && !controller.getState().fault; i++) {
      const before = structuredClone(controller.getState().match);
      controller.tick();
      if (before.revision !== controller.getState().match.revision) rounds.push(before);
    }
    assert.ok(controller.getState().match.outcome, `${scenario.script} reaches an outcome`);
    const finalMatch = structuredClone(controller.getState().match);
    const finalLog = structuredClone(controller.getState().lastLog);
    controller.startReplay();
    for (const before of rounds) {
      const replay = controller.getState();
      const events = replay.performance!.events;
      const schedule = performanceHealthSchedule(events, replay.replay!.combat.healthTimeline, replay.replay!.combat.presentationChanges);
      assert.ok(schedule, `${scenario.script} turn ${before.turn} has verified cues`);
      const at = new Map<string, { x: number; y: number }>([
        ...before.mechs.map(m => [m.id, m.pos] as const),
        ...before.raiders.map(r => [r.id, r.pos] as const),
        ["boss", before.boss.anchor],
      ]);
      const defeated = new Set<string>();
      for (const [index, event] of events.entries()) {
        if (event.kind === "move" || event.kind === "knockback") {
          assert.ok(!defeated.has(event.actor), `${event.actor} must not move after defeat`);
          at.set(event.actor, event.path[event.path.length - 1]!);
        } else if (event.kind === "attack") {
          assert.ok(!defeated.has(event.actor), `${event.actor} must not attack after defeat`);
        } else if (event.kind === "death") {
          assert.ok(!defeated.has(event.actor), `${event.actor} must be defeated only once`);
          defeated.add(event.actor);
          assert.deepEqual(event.at, at.get(event.actor), "defeat uses the position at this cue");
        }
        for (const effect of schedule[index]!) {
          if (effect.kind === "building" || effect.before <= 0 || effect.after > 0) continue;
          const following = events.slice(index + 1);
          const nextAction = following.findIndex(e => e.kind !== "death");
          const adjacentDeaths = following.slice(0, nextAction < 0 ? following.length : nextAction);
          assert.ok(adjacentDeaths.some(e => e.kind === "death" && e.actor === effect.id), `${effect.id} is defeated immediately after its lethal cue`);
          defeats++;
          if (following.some(e => e.kind !== "death")) earlyDefeats++;
        }
      }
      assert.deepEqual(replay.match, finalMatch);
      assert.deepEqual(replay.lastLog, finalLog);
      controller.finishPerformance();
    }
    assert.deepEqual(controller.getState().match, finalMatch);
  }
  assert.ok(defeats > 0, "real matches include defeats");
  assert.ok(earlyDefeats > 0, "at least one defeat precedes another action");
});

test("missing or invalid timing evidence falls back to end-of-turn defeats", () => {
  const before = createMatch({ preset: "covers_sparse_mid", script: "siege" });
  const target = before.raiders[0]!;
  const after = structuredClone(before);
  after.raiders[0]!.hp = 0;
  const log: TurnEvent[] = [
    { type: "act", mechId: "Assault", action: "melee", target: target.id, damage: target.hp },
    { type: "act", mechId: "Gunner", action: "shoot", target: "boss", damage: 1 },
  ];
  const withoutEvidence = performanceFromLog(before, after, log);
  const invalidEvidence = performanceFromLog(before, after, log, {
    healthTimeline: { ok: false, reason: "incomplete" },
    presentationChanges: { ok: false, reason: "incomplete" },
  });
  assert.deepEqual(invalidEvidence, withoutEvidence);
  assert.deepEqual(withoutEvidence.map(event => event.kind), ["attack", "attack", "death"]);
  assert.deepEqual(withoutEvidence.at(-1), { kind: "death", actor: target.id, at: target.pos, duration: 0.85 });
});


test("verified collision deaths share the causal attack cue", async () => {
  const { buildHealthTimeline } = await import("../src/game/mecha/healthTimeline.ts");
  const { buildPresentationChanges } = await import("../src/game/mecha/presentationChanges.ts");
  const { performanceHealthSchedule } = await import("../src/game/mecha/performanceHealth.ts");
  const before = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 }, mechs: [
    { id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 0 } }, { id: "Support", pos: { x: 7, y: 0 } },
  ] });
  before.boss.hp = 3;
  before.mechs.find(m => m.id === "Gunner")!.hp = 1;
  bossPrepare(before);
  const result = playTurn(before, { revision: before.revision, items: [
    { mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    { mechId: "Support", moveTo: null, action: { kind: "skip" } },
  ] });
  assert.ok(result.ok);
  assert.ok(result.presentationStages);
  const healthTimeline = buildHealthTimeline(before, result.state, result.log);
  const presentationChanges = buildPresentationChanges(result.presentationStages, result.log);
  assert.equal(healthTimeline.ok, true);
  assert.equal(presentationChanges.ok, true);
  const events = performanceFromLog(before, result.state, result.log, { healthTimeline, presentationChanges });
  const schedule = performanceHealthSchedule(events, healthTimeline, presentationChanges);
  assert.ok(schedule);
  assert.deepEqual(schedule[0]!.filter(e => e.before > 0 && e.after === 0).map(e => e.id), ["boss", "Gunner"]);
  assert.deepEqual(events.map(e => e.kind), ["attack", "death", "death"]);
  assert.deepEqual(events.slice(1).map(e => e.actor), ["boss", "Gunner"]);
  assert.deepEqual(events.slice(1).map(e => e.kind === "death" && e.at), [{ x: 4, y: 0 }, { x: 6, y: 0 }]);
});
