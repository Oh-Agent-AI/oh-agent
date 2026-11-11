import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SequentialTurn } from "../src/game/mecha/sequentialTurn.ts";
import { sequentialPresentation } from "../src/game/mecha/sequentialPresentation.ts";
import { SequentialController } from "../src/game/mecha/sequentialController.ts";
import { createSequentialArchive, replaySequentialArchive } from "../src/game/mecha/sequentialReplay.ts";
import { displacementWorld, resolveDisplacement } from "../src/game/mecha/board.ts";
import { verifyStatusLedger } from "../src/game/mecha/statusTimeline.ts";
import { verifyStatusGeometry } from "../src/game/mecha/statusGeometry.ts";
import { buildPresentationChanges } from "../src/game/mecha/presentationChanges.ts";
import { buildHealthTimeline } from "../src/game/mecha/healthTimeline.ts";
import { performanceFromLog } from "../src/game/mecha/performance.ts";
import { performanceHealthSchedule } from "../src/game/mecha/performanceHealth.ts";
import { applyStatusDisplayCue, type DisplayStatus } from "../src/game/mecha/statusDisplay.ts";

function displayStatuses(statuses: readonly DisplayStatus[]): DisplayStatus[] {
  return statuses.map(({ target, source, kind, remainingTurns }) => ({ target, source, kind, remainingTurns }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
import type { Status } from "../src/game/mecha/statusEffects.ts";

function fixture(statuses: Status[]) {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(state);
  state.statusEncounter = { schema: "mecha-status-encounter:v1", statuses };
  return state;
}
const status = (kind: Status["kind"], target = "Assault", remainingTurns = 1): Status => ({ kind, target, source: "boss", magnitude: kind === "poison" || kind === "burn" ? 1 : 0, remainingTurns });

test("freeze and stun reject commands atomically while freeze permits an action", () => {
  const initial = fixture([status("freeze"), status("stun", "Gunner")]), session = new SequentialTurn(initial);
  assert.deepEqual(session.execute({ kind: "move", id: "f", revision: initial.revision, mech: "Assault", to: { x: 3, y: 2 } }), { ok: false, reason: "status_blocks_move" });
  assert.deepEqual(session.execute({ kind: "act", id: "s", revision: initial.revision, mech: "Gunner", action: { kind: "skip" } }), { ok: false, reason: "status_blocks_action" });
  assert.deepEqual(session.snapshot().match, initial);
  const acted = session.execute({ kind: "act", id: "a", revision: initial.revision, mech: "Assault", action: { kind: "skip" } });
  assert.ok(acted.ok);
  const reset = session.execute({ kind: "reset", id: "r", revision: acted.snapshot.match.revision });
  assert.ok(reset.ok); assert.deepEqual(reset.snapshot.match.statusEncounter, initial.statusEncounter);
});

test("turn-end status ticks are ordered, replayable and duplicate commands cannot tick twice", () => {
  const initial = fixture([status("poison", "Gunner", 2), status("burn", "Gunner", 2)]), session = new SequentialTurn(initial);
  const end = { kind: "end" as const, id: "end", revision: initial.revision, confirmUnused: true };
  const result = session.execute(end); assert.ok(result.ok);
  assert.equal(result.snapshot.match.mechs.find(m => m.id === "Gunner")!.hp, initial.mechs.find(m => m.id === "Gunner")!.hp - 2);
  assert.deepEqual(result.events.filter(e => e.type === "status_effect" && e.event.type === "status_damage").map(e => e.type === "status_effect" && e.event.type === "status_damage" ? e.event.kind : null), ["burn", "poison"]);
  assert.deepEqual(session.execute(end), result);
  assert.deepEqual(SequentialTurn.replay(initial, session.records()).snapshot(), session.snapshot());
  assert.deepEqual(verifyStatusLedger(initial, result.snapshot.match, result.events), { ok: true });
  assert.deepEqual(verifyStatusLedger(initial, result.snapshot.match, result.events, result.presentationStages), { ok: true });
  const changes = buildPresentationChanges(result.presentationStages!, result.events);
  const health = buildHealthTimeline(initial, result.snapshot.match, result.events, result.presentationStages);
  assert.ok(changes.ok); assert.ok(health.ok);
  const withoutStatusEvidence = performanceFromLog(initial, result.snapshot.match, result.events, { presentationChanges: changes, healthTimeline: health });
  assert.equal(withoutStatusEvidence.some(e => e.kind === "status_cue"), false);
  const cues = performanceFromLog(initial, result.snapshot.match, result.events, { presentationChanges: changes, healthTimeline: health, statusVerified: true });
  let display = displayStatuses(initial.statusEncounter!.statuses);
  for (const cue of cues) if (cue.kind === "status_cue") { const next = applyStatusDisplayCue(display, cue); assert.ok(next); display = next; }
  assert.deepEqual(displayStatuses(display), displayStatuses(result.snapshot.match.statusEncounter!.statuses));
  const damageCues = cues.filter(e => e.kind === "status_cue" && e.change === "damage");
  assert.equal(damageCues.length, 2);
  const schedule = performanceHealthSchedule(cues, health, changes); assert.ok(schedule);
  for (const cue of damageCues) {
    const index = cues.indexOf(cue);
    assert.ok(schedule[index]!.some(effect => effect.kind === "mech" && effect.id === "Gunner"));
  }
  const wrongStage = structuredClone(result.presentationStages)!;
  wrongStage.afterPlayer.statusEncounter!.statuses[0]!.remainingTurns++;
  assert.equal(verifyStatusLedger(initial, result.snapshot.match, result.events, wrongStage).ok, false);
  assert.equal(verifyStatusLedger(initial, result.snapshot.match, result.events.filter(e => e.type !== "status_boundary"), result.presentationStages).ok, false);
  const missing = result.events.filter(e => e.type !== "status_effect" || e.event.type !== "status_advanced");
  assert.equal(verifyStatusLedger(initial, result.snapshot.match, missing).ok, false);
  const altered = structuredClone(result.events);
  const tick = altered.find(e => e.type === "status_effect" && e.event.type === "status_damage");
  assert.ok(tick && tick.type === "status_effect" && tick.event.type === "status_damage"); tick.event.amount++;
  assert.equal(verifyStatusLedger(initial, result.snapshot.match, altered).ok, false);
  assert.ok(sequentialPresentation(initial, result.snapshot.match, result.events, result.presentationStages).ok);
  const second = session.execute({ ...end, id: "end2", revision: result.snapshot.match.revision }); assert.ok(second.ok);
  assert.equal(second.snapshot.match.mechs.find(m => m.id === "Gunner")!.hp, initial.mechs.find(m => m.id === "Gunner")!.hp - 4);
  assert.deepEqual(second.snapshot.match.statusEncounter?.statuses, []);
});

test("deadly status damage ends battle before enemy actions", () => {
  const initial = fixture([status("burn")]);
  initial.mechs.find(m => m.id === "Assault")!.hp = 1;
  initial.mechs.find(m => m.id === "Gunner")!.hp = 0;
  initial.mechs.find(m => m.id === "Support")!.hp = 0;
  const session = new SequentialTurn(initial);
  const result = session.execute({ kind: "end", id: "end", revision: initial.revision, confirmUnused: true });
  assert.ok(result.ok); assert.equal(result.snapshot.match.outcome, "defeat_wipe");
  assert.deepEqual(verifyStatusLedger(initial, result.snapshot.match, result.events), { ok: true });
  assert.ok(sequentialPresentation(initial, result.snapshot.match, result.events, result.presentationStages).ok);
  assert.equal(result.events.some(e => e.type === "enemy"), false);
  assert.deepEqual(result.snapshot.match.statusEncounter?.statuses, []);
});

test("invalid or duplicate ledgers are rejected at the authority boundary", () => {
  const state = fixture([status("poison"), status("poison")]);
  assert.throws(() => new SequentialTurn(state), /invalid_status/);
  state.statusEncounter!.statuses = [status("poison", "unknown")];
  assert.throws(() => new SequentialTurn(state), /invalid_status_ledger/);
  const legacy = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash" });
  legacy.statusEncounter = { schema: "mecha-status-encounter:v1", statuses: [] };
  assert.throws(() => bossPrepare(legacy), /unsupported_status_encounter/);
});

test("pre-seeded status encounters cannot masquerade as a validated opening", async () => {
  const state = fixture([status("poison")]);
  assert.throws(() => new SequentialController(state), /status_encounter_not_available/);
  await assert.rejects(createSequentialArchive(state, []), /invalid_sequential_archive/);
  await assert.rejects(replaySequentialArchive(state, "{}"), /invalid_sequential_archive/);
});

test("unavailable actions on stunned mechs do not require end-turn confirmation", () => {
  const state = fixture([status("stun"), status("stun", "Gunner"), status("stun", "Support")]);
  const result = new SequentialTurn(state).execute({ kind: "end", id: "end", revision: state.revision, confirmUnused: false });
  assert.ok(result.ok);
});

for (const [speciesId, kind] of [["spore_leaper", "poison"], ["flux_lancer", "burn"]] as const) {
  test(`${speciesId} applies ${kind} only to a surviving mech actually hit`, () => {
    const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 }, covers: [],
      mechs: [{ id: "Assault", pos: { x: 3, y: 5 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }],
      raiders: [], monsterContent: { speciesId, contentVersion: 1 } });
    bossPrepare(state); state.statusEncounter = { schema: "mecha-status-encounter:v1", statuses: [] };
    const session = new SequentialTurn(state);
    const result = session.execute({ kind: "end", id: "end", revision: state.revision, confirmUnused: true });
    assert.ok(result.ok);
    assert.deepEqual(verifyStatusLedger(state, result.snapshot.match, result.events), { ok: true });
    assert.deepEqual(verifyStatusGeometry(state, result.events), { ok: true });
    const changes = buildPresentationChanges(result.presentationStages!, result.events);
    const health = buildHealthTimeline(state, result.snapshot.match, result.events, result.presentationStages);
    assert.ok(changes.ok); assert.ok(health.ok);
    const cues = performanceFromLog(state, result.snapshot.match, result.events, { presentationChanges: changes, healthTimeline: health, statusVerified: true });
    assert.ok(cues.some(e => e.kind === "status_cue" && e.status === kind && e.change === "applied" && e.actor === "Assault"));
    let display: DisplayStatus[] = [];
    for (const cue of cues) if (cue.kind === "status_cue") { const next = applyStatusDisplayCue(display, cue); assert.ok(next); display = next; }
    assert.deepEqual(displayStatuses(display), displayStatuses(result.snapshot.match.statusEncounter!.statuses));
    const hitIndex = result.events.findIndex(e => e.type === "status_hit" && e.target === "Assault");
    const appliedIndex = result.events.findIndex(e => e.type === "status_effect" && e.event.type === "status_applied" && e.event.status.target === "Assault");
    assert.ok(hitIndex >= 0 && appliedIndex > hitIndex, "confirmed hit precedes status application");
    assert.equal(verifyStatusLedger(state, result.snapshot.match, result.events.filter((_e, index) => index !== hitIndex)).ok, false);
    const badHit = structuredClone(result.events), hitEvent = badHit[hitIndex];
    assert.ok(hitEvent?.type === "status_hit"); hitEvent.cell.x++;
    assert.equal(verifyStatusGeometry(state, badHit).ok, false, "a hit cannot move away from the actual target");
    if (speciesId === "spore_leaper") {
      const badLanding = structuredClone(result.events), bossMove = badLanding.find(e => e.type === "boss_move");
      assert.ok(bossMove && bossMove.type === "boss_move"); bossMove.to.x++;
      assert.equal(verifyStatusGeometry(state, badLanding).ok, false, "spore landing remains bound to its declared offset");
    }
    const omittedHit = result.events.filter((_e, index) => index !== hitIndex && index !== appliedIndex);
    assert.equal(verifyStatusGeometry(state, omittedHit).ok, false, "surviving damage victims require hit evidence");
    const forgedEvents = structuredClone(result.events), forgedAfter = structuredClone(result.snapshot.match);
    const forgedApplication = forgedEvents[appliedIndex];
    assert.ok(forgedApplication?.type === "status_effect" && forgedApplication.event.type === "status_applied");
    forgedApplication.event.status.magnitude = 99;
    forgedAfter.statusEncounter!.statuses.find(s => s.target === "Assault")!.magnitude = 99;
    assert.equal(verifyStatusLedger(state, forgedAfter, forgedEvents).ok, false, "a matching forged final state cannot redefine skill strength");
    assert.ok(result.events.some(e => e.type === "status_effect" && e.event.type === "status_applied" && e.event.status.kind === kind && e.event.status.target === "Assault"));
    assert.equal(result.snapshot.match.statusEncounter?.statuses[0]?.kind, kind);
    assert.deepEqual(SequentialTurn.replay(state, session.records()).snapshot(), session.snapshot());
    assert.ok(sequentialPresentation(state, result.snapshot.match, result.events, result.presentationStages).ok);
    const lethal = structuredClone(state); lethal.mechs.find(m => m.id === "Assault")!.hp = 1;
    const killed = new SequentialTurn(lethal).execute({ kind: "end", id: "end", revision: lethal.revision, confirmUnused: true });
    assert.ok(killed.ok);
    assert.equal(killed.snapshot.match.mechs.find(m => m.id === "Assault")!.hp, 0);
    assert.equal(killed.snapshot.match.statusEncounter?.statuses.some(s => s.target === "Assault"), false);
    assert.equal(killed.events.some(e => e.type === "status_hit" && e.target === "Assault"), false);
    const dodged = structuredClone(state); dodged.mechs.find(m => m.id === "Assault")!.pos = { x: 0, y: 0 };
    const missed = new SequentialTurn(dodged).execute({ kind: "end", id: "end", revision: dodged.revision, confirmUnused: true });
    assert.ok(missed.ok);
    assert.equal(missed.snapshot.match.statusEncounter?.statuses.some(s => s.target === "Assault"), false);
  });
}

test("gravity collision is explicitly evidenced and stuns even when every pull is blocked", () => {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 }, covers: [], obstacles: [{ x: 4, y: 6 }],
    mechs: [{ id: "Assault", pos: { x: 4, y: 7 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }],
    raiders: [], buildings: [], monsterContent: { speciesId: "gravity_core", contentVersion: 1 } });
  state.statusEncounter = { schema: "mecha-status-encounter:v1", statuses: [] };
  bossPrepare(state);
  assert.equal(state.boss.intent?.status, "planned");
  assert.ok(state.boss.intent?.displacementProjection?.effects.some(e => e.entityId === "mech:Assault" && e.reason === "obstacle"));
  const binding = state.boss.intent!.displacement!, projection = state.boss.intent!.displacementProjection!;
  const changedBlocker = structuredClone(state);
  changedBlocker.obstacles = [];
  changedBlocker.buildings.push({ id: "tower", cells: [{ x: 4, y: 6 }], hp: 10, maxHp: 10 });
  assert.deepEqual(resolveDisplacement(displacementWorld(changedBlocker), binding, projection), { status: "void", reason: "stale_projection", effects: [], attackCells: [] });
  const turn = new SequentialTurn(state);
  const result = turn.execute({ kind: "end", id: "end", revision: state.revision, confirmUnused: true });
  assert.ok(result.ok);
  assert.deepEqual(verifyStatusLedger(state, result.snapshot.match, result.events), { ok: true });
  assert.deepEqual(verifyStatusGeometry(state, result.events), { ok: true });
  assert.ok(sequentialPresentation(state, result.snapshot.match, result.events, result.presentationStages).ok);
  const hit = result.events.find(e => e.type === "gravity_collision");
  assert.ok(hit && hit.type === "gravity_collision");
  assert.deepEqual({ target: hit.target, cell: hit.cell, blocker: hit.blocker }, { target: "Assault", cell: { x: 4, y: 6 }, blocker: { kind: "obstacle", id: "4,6" } });
  const forged = structuredClone(result.events), collision = forged.find(e => e.type === "gravity_collision");
  assert.ok(collision && collision.type === "gravity_collision"); collision.blocker.id = "wrong";
  assert.equal(verifyStatusGeometry(state, forged).ok, false, "the collision blocker must match the current projection");
  assert.equal(verifyStatusGeometry(state, result.events.filter(e => e.type !== "gravity_collision")).ok, false, "a blocked pull cannot hide its collision");
  assert.ok(result.snapshot.match.statusEncounter?.statuses.some(s => s.target === "Assault" && s.kind === "stun"));
  assert.deepEqual(turn.execute({ kind: "act", id: "blocked", revision: result.snapshot.match.revision, mech: "Assault", action: { kind: "skip" } }), { ok: false, reason: "status_blocks_action" });
  assert.deepEqual(SequentialTurn.replay(state, turn.records()).snapshot(), turn.snapshot());
});

for (const kind of ["building", "mech", "raider", "mountain", "water"] as const) {
  test(`gravity distinguishes ${kind} from valid collision blockers`, () => {
    const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 }, covers: [], obstacles: [],
      mechs: [{ id: "Assault", pos: { x: 4, y: 7 } }, { id: "Gunner", pos: kind === "mech" ? { x: 4, y: 6 } : { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }],
      raiders: kind === "raider" ? [{ id: "r1", pos: { x: 4, y: 6 } }] : [],
      buildings: kind === "building" ? [{ id: "tower", cells: [{ x: 4, y: 6 }], hp: 10 }] : [],
      monsterContent: { speciesId: "gravity_core", contentVersion: 1 } });
    if (kind === "mountain" || kind === "water") state.terrain[6]![4] = kind;
    state.statusEncounter = { schema: "mecha-status-encounter:v1", statuses: [] };
    bossPrepare(state);
    const result = new SequentialTurn(state).execute({ kind: "end", id: "end", revision: state.revision, confirmUnused: true });
    assert.ok(result.ok);
    assert.deepEqual(verifyStatusLedger(state, result.snapshot.match, result.events), { ok: true });
    assert.deepEqual(verifyStatusGeometry(state, result.events), { ok: true });
    assert.ok(sequentialPresentation(state, result.snapshot.match, result.events, result.presentationStages).ok);
    const hit = result.events.find(e => e.type === "gravity_collision" && e.target === "Assault");
    if (kind === "mountain" || kind === "water") {
      assert.equal(hit, undefined);
      assert.equal(result.snapshot.match.statusEncounter?.statuses.some(s => s.target === "Assault"), false);
    } else {
      assert.ok(hit && hit.type === "gravity_collision"); assert.equal(hit.blocker.kind, kind);
      assert.ok(result.snapshot.match.statusEncounter?.statuses.some(s => s.target === "Assault" && s.kind === "stun"));
    }
  });
}

test("prism frost declares a fixed ray, hits the first mech and freezes only surviving targets", () => {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 }, covers: [], obstacles: [], buildings: [], raiders: [],
    mechs: [{ id: "Assault", pos: { x: 4, y: 7 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }],
    monsterContent: { speciesId: "prism_warden", contentVersion: 1 } });
  state.statusEncounter = { schema: "mecha-status-encounter:v1", statuses: [] }; bossPrepare(state);
  assert.equal(state.boss.intent?.skillId, "prism_frost");
  assert.deepEqual(state.boss.intent?.projected, [{ x: 4, y: 6 }, { x: 4, y: 7 }, { x: 4, y: 8 }, { x: 4, y: 9 }]);
  const session = new SequentialTurn(state);
  const result = session.execute({ kind: "end", id: "end", revision: state.revision, confirmUnused: true }); assert.ok(result.ok);
  assert.deepEqual(verifyStatusGeometry(state, result.events), { ok: true });
  assert.ok(sequentialPresentation(state, result.snapshot.match, result.events, result.presentationStages).ok);
  assert.ok(result.snapshot.match.statusEncounter?.statuses.some(s => s.kind === "freeze" && s.target === "Assault"));
  assert.ok(result.events.some(e => e.type === "status_hit" && e.skill === "prism_frost" && e.target === "Assault"));
  assert.equal(result.snapshot.match.boss.intent?.skillId, "prism_guard");
  assert.deepEqual(session.execute({ kind: "move", id: "m", revision: result.snapshot.match.revision, mech: "Assault", to: { x: 3, y: 7 } }), { ok: false, reason: "status_blocks_move" });
  assert.deepEqual(SequentialTurn.replay(state, session.records()).snapshot(), session.snapshot());

  const dodged = new SequentialTurn(state);
  const moved = dodged.execute({ kind: "move", id: "m", revision: state.revision, mech: "Assault", to: { x: 3, y: 7 } }); assert.ok(moved.ok);
  const miss = dodged.execute({ kind: "end", id: "e", revision: moved.snapshot.match.revision, confirmUnused: true }); assert.ok(miss.ok);
  assert.equal(miss.snapshot.match.statusEncounter?.statuses.some(s => s.kind === "freeze"), false);

  const intercepted = structuredClone(state); intercepted.mechs.find(m => m.id === "Gunner")!.pos = { x: 4, y: 6 };
  const first = new SequentialTurn(intercepted).execute({ kind: "end", id: "e", revision: intercepted.revision, confirmUnused: true }); assert.ok(first.ok);
  assert.deepEqual(first.snapshot.match.statusEncounter?.statuses.map(s => s.target), ["Gunner"]);
  assert.deepEqual(verifyStatusGeometry(intercepted, first.events), { ok: true });
  const killed = structuredClone(state); killed.mechs.find(m => m.id === "Assault")!.hp = 1;
  const lethal = new SequentialTurn(killed).execute({ kind: "end", id: "e", revision: killed.revision, confirmUnused: true }); assert.ok(lethal.ok);
  assert.equal(lethal.snapshot.match.statusEncounter?.statuses.some(s => s.target === "Assault"), false);
});

test("prism guard stays unchanged without explicitly enabled status rules", () => {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 }, covers: [],
    mechs: [{ id: "Assault", pos: { x: 4, y: 7 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }],
    monsterContent: { speciesId: "prism_warden", contentVersion: 1 } });
  bossPrepare(state); assert.equal(state.boss.intent?.skillId, "prism_guard");
});

test("enemy death clears status before capturing the enemy and prepare stages", () => {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 }, covers: [], obstacles: [], buildings: [], raiders: [],
    mechs: [{ id: "Assault", pos: { x: 3, y: 5 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }],
    monsterContent: { speciesId: "spore_leaper", contentVersion: 1 } });
  bossPrepare(state); state.mechs.find(m => m.id === "Assault")!.hp = 4;
  state.statusEncounter = { schema: "mecha-status-encounter:v1", statuses: [status("poison", "Assault", 2)] };
  const result = new SequentialTurn(state).execute({ kind: "end", id: "end", revision: state.revision, confirmUnused: true }); assert.ok(result.ok);
  assert.equal(result.snapshot.match.mechs.find(m => m.id === "Assault")!.hp, 0);
  assert.equal(result.presentationStages!.afterPlayer.statusEncounter!.statuses.length, 1);
  assert.deepEqual(result.presentationStages!.afterEnemy.statusEncounter!.statuses, []);
  assert.deepEqual(result.presentationStages!.afterPrepare.statusEncounter!.statuses, []);
  assert.deepEqual(verifyStatusLedger(state, result.snapshot.match, result.events, result.presentationStages), { ok: true });
  assert.deepEqual(verifyStatusGeometry(state, result.events), { ok: true });
  assert.ok(sequentialPresentation(state, result.snapshot.match, result.events, result.presentationStages).ok);
});
