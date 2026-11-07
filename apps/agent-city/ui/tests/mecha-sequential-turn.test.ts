import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SequentialTurn } from "../src/game/mecha/sequentialTurn.ts";

function fixture() {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(state); return state;
}

test("moves are committed in order, undo is LIFO, and duplicate commands are idempotent", () => {
  const state = fixture(), session = new SequentialTurn(state), before = structuredClone(state);
  const move = { kind: "move" as const, id: "a", revision: state.revision, mech: "Assault" as const, to: { x: 3, y: 2 } };
  const first = session.execute(move); assert.ok(first.ok); assert.deepEqual(first.snapshot.match.mechs[0]!.pos, move.to);
  assert.deepEqual(session.execute(move), first); assert.deepEqual(state, before);
  assert.deepEqual(session.execute({ to: { y: 2, x: 3 }, mech: "Assault", revision: state.revision, id: "a", kind: "move" }), first);
  assert.deepEqual(session.execute({ ...move, to: { x: 3, y: 1 } }), { ok: false, reason: "duplicate_command" });
  const second = session.execute({ kind: "move", id: "b", revision: first.snapshot.match.revision, mech: "Gunner", to: { x: 1, y: 5 } }); assert.ok(second.ok);
  const undo = session.execute({ kind: "undo", id: "u", revision: second.snapshot.match.revision }); assert.ok(undo.ok);
  assert.deepEqual(undo.causalEvent, { schema: "mecha-sequential-event:v1", ruleset: "mecha-v1.5", kind: "undo_move", commandId: "u", baseRevision: second.snapshot.match.revision, revision: second.snapshot.match.revision + 1, mech: "Gunner", from: { x: 1, y: 5 }, to: { x: 1, y: 6 } });
  assert.deepEqual(undo.snapshot.match.mechs[1]!.pos, state.mechs[1]!.pos);
  assert.deepEqual(undo.snapshot.match.mechs[0]!.pos, move.to);
});

test("action is immediate, locks movement, and reset restores the checkpoint exactly once", () => {
  const state = fixture(), session = new SequentialTurn(state);
  const move = session.execute({ kind: "move", id: "move", revision: state.revision, mech: "Assault", to: { x: 3, y: 1 } }); assert.ok(move.ok);
  const action = session.execute({ kind: "act", id: "hit", revision: move.snapshot.match.revision, mech: "Assault", action: { kind: "charge", target: "boss" } }); assert.ok(action.ok);
  assert.ok(action.snapshot.match.boss.hp < state.boss.hp); assert.ok(action.events.some(e => e.type === "act"));
  assert.equal(session.execute({ kind: "undo", id: "undo", revision: action.snapshot.match.revision }).ok, false);
  assert.equal(session.execute({ kind: "move", id: "again", revision: action.snapshot.match.revision, mech: "Assault", to: { x: 2, y: 1 } }).ok, false);
  const reset = session.execute({ kind: "reset", id: "reset", revision: action.snapshot.match.revision }); assert.ok(reset.ok);
  assert.deepEqual(reset.causalEvent, { schema: "mecha-sequential-event:v1", ruleset: "mecha-v1.5", kind: "reset_turn", commandId: "reset", baseRevision: action.snapshot.match.revision, revision: action.snapshot.match.revision + 1, checkpointRevision: state.revision });
  assert.deepEqual(reset.snapshot.match.mechs, state.mechs); assert.equal(reset.snapshot.match.boss.hp, state.boss.hp);
  assert.equal(session.execute({ kind: "reset", id: "reset2", revision: reset.snapshot.match.revision }).ok, false);
});

test("a different mech acting preserves move undo until the moved mech acts", () => {
  const state = fixture(), session = new SequentialTurn(state);
  const moved = session.execute({ kind: "move", id: "support-move", revision: state.revision, mech: "Support", to: { x: 8, y: 7 } });
  assert.ok(moved.ok); assert.equal(session.canUndo(), true);
  const assault = session.execute({ kind: "act", id: "assault-hold", revision: moved.snapshot.match.revision, mech: "Assault", action: { kind: "skip" } });
  assert.ok(assault.ok); assert.equal(assault.snapshot.rights.Support.action, true);
  assert.deepEqual(session.turnActivity(), { moved: ["Support"], acted: ["Assault"] }, "acting without moving must not be reported as movement");
  assert.deepEqual(assault.snapshot.undo, [], "the existing serialized snapshot field keeps its previous shape and semantics");
  assert.equal(session.canUndo(), true, "another mech's action does not lock Support's uncommitted position");
  const trial = session.trial({ kind: "undo", id: "trial-support-undo", revision: assault.snapshot.match.revision });
  assert.ok(trial.ok); assert.deepEqual(trial.snapshot.match.mechs.find(unit => unit.id === "Support")!.pos, { x: 8, y: 8 });
  const undone = session.execute({ kind: "undo", id: "support-undo", revision: assault.snapshot.match.revision });
  assert.ok(undone.ok); assert.deepEqual(undone.snapshot.match.mechs.find(unit => unit.id === "Support")!.pos, { x: 8, y: 8 });
  assert.equal(undone.snapshot.rights.Support.move, true); assert.equal(session.canUndo(), false);
  assert.deepEqual(session.turnActivity(), { moved: [], acted: ["Assault"] }, "undo clears only the committed move");
  assert.deepEqual(SequentialTurn.replay(state, session.records()).snapshot(), session.snapshot(), "command replay reconstructs pending undo without changing the archive shape");
});

test("undo skips a newer move when a boss was pushed into its source cell", () => {
  const state = fixture();
  state.mechs.find(unit => unit.id === "Support")!.pos = { x: 3, y: 0 };
  state.mechs.find(unit => unit.id === "Assault")!.pos = { x: 6, y: 0 };
  const session = new SequentialTurn(state);
  const gunner = session.execute({ kind: "move", id: "gunner", revision: state.revision, mech: "Gunner", to: { x: 1, y: 5 } });
  assert.ok(gunner.ok);
  const support = session.execute({ kind: "move", id: "support", revision: gunner.snapshot.match.revision, mech: "Support", to: { x: 3, y: 2 } });
  assert.ok(support.ok);
  const charge = session.execute({ kind: "act", id: "charge", revision: support.snapshot.match.revision, mech: "Assault", action: { kind: "charge", target: "boss" } });
  assert.ok(charge.ok);
  assert.deepEqual(charge.snapshot.match.boss.anchor, { x: 3, y: 0 });
  const undone = session.execute({ kind: "undo", id: "undo", revision: charge.snapshot.match.revision });
  assert.ok(undone.ok);
  assert.equal(undone.causalEvent?.kind === "undo_move" && undone.causalEvent.mech, "Gunner");
  assert.deepEqual(undone.snapshot.match.mechs.find(unit => unit.id === "Support")!.pos, { x: 3, y: 2 });
  assert.equal(session.canUndo(), false);
  assert.deepEqual(SequentialTurn.replay(state, session.records()).snapshot(), session.snapshot());
});

test("invalid moves and stale commands do not alter the authority", () => {
  const state = fixture(), session = new SequentialTurn(state), before = session.snapshot();
  assert.equal(session.execute({ kind: "move", id: "x", revision: state.revision, mech: "Assault", to: { x: 99, y: 1 } }).ok, false);
  assert.equal(session.execute({ kind: "reset", id: "y", revision: state.revision - 1 }).ok, false);
  assert.deepEqual(session.snapshot(), before);
  assert.throws(() => new SequentialTurn({ ...state, ruleset: "mecha-v1.4" }), /invalid_sequential_start/);
  const exhausted = structuredClone(state); exhausted.revision = Number.MAX_SAFE_INTEGER;
  const limited = new SequentialTurn(exhausted), unchanged = limited.snapshot();
  assert.deepEqual(limited.execute({ kind: "reset", id: "limit", revision: exhausted.revision }), { ok: false, reason: "revision_exhausted" });
  assert.deepEqual(limited.snapshot(), unchanged);
});

test("trial forks the current authority including undo and reset state without changing history", () => {
  const state = fixture(), session = new SequentialTurn(state);
  const moved = session.execute({ kind: "move", id: "committed-move", revision: state.revision, mech: "Assault", to: { x: 3, y: 2 } }); assert.ok(moved.ok);
  const before = session.snapshot(), records = session.records();
  const trialUndo = session.trial({ kind: "undo", id: "trial-undo", revision: before.match.revision });
  assert.ok(trialUndo.ok); assert.deepEqual(trialUndo.snapshot.match.mechs[0]!.pos, { x: 3, y: 3 });
  assert.deepEqual(session.snapshot(), before); assert.deepEqual(session.records(), records);
  const trialReset = session.trial({ kind: "reset", id: "trial-reset", revision: before.match.revision });
  assert.ok(trialReset.ok); assert.deepEqual(trialReset.snapshot.match.mechs, state.mechs);
  assert.deepEqual(session.snapshot(), before); assert.deepEqual(session.records(), records);
});

test("a unit may pass through an ally but cannot end on its occupied cell", () => {
  const state = fixture();
  state.mechs.find(m => m.id === "Gunner")!.pos = { x: 3, y: 2 };
  const session = new SequentialTurn(state), before = session.snapshot();
  assert.deepEqual(session.execute({ kind: "move", id: "occupied", revision: state.revision, mech: "Assault", to: { x: 3, y: 2 } }), { ok: false, reason: "invalid_move" });
  assert.deepEqual(session.snapshot(), before);
  const passed = session.execute({ kind: "move", id: "pass", revision: state.revision, mech: "Assault", to: { x: 3, y: 1 } });
  assert.ok(passed.ok);
});

test("ending the player phase confirms unused actions, runs the enemy once and opens the next checkpoint", () => {
  const state = fixture(), session = new SequentialTurn(state), start = session.snapshot();
  const command = { kind: "end" as const, id: "end", revision: state.revision, confirmUnused: false };
  assert.deepEqual(session.execute(command), { ok: false, reason: "confirmation_required" });
  assert.deepEqual(session.snapshot(), start);
  const committed = session.execute({ ...command, confirmUnused: true }); assert.ok(committed.ok);
  assert.equal(committed.snapshot.match.turn, state.turn + 1);
  assert.equal(committed.snapshot.match.phase, "player_plan");
  assert.equal(committed.snapshot.match.revision, state.revision + 1);
  assert.ok(committed.events.some(e => e.type === "enemy"));
  assert.deepEqual(session.execute({ ...command, confirmUnused: true }), committed);
  assert.deepEqual(session.snapshot(), committed.snapshot, "retry cannot run the enemy twice");
  const afterMove = session.execute({ kind: "move", id: "next-move", revision: committed.snapshot.match.revision, mech: "Gunner", to: { x: 1, y: 5 } }); assert.ok(afterMove.ok);
  const reset = session.execute({ kind: "reset", id: "next-reset", revision: afterMove.snapshot.match.revision }); assert.ok(reset.ok);
  assert.deepEqual(reset.snapshot.match.mechs, committed.snapshot.match.mechs);
  assert.equal(reset.snapshot.resetUsed, true);
  assert.equal(session.canUndo(), false);
});

test("reset consumption remains spent across later turns", () => {
  const state = fixture(), session = new SequentialTurn(state);
  const reset = session.execute({ kind: "reset", id: "r", revision: state.revision }); assert.ok(reset.ok);
  const ended = session.execute({ kind: "end", id: "e", revision: reset.snapshot.match.revision, confirmUnused: true }); assert.ok(ended.ok);
  assert.deepEqual(session.execute({ kind: "reset", id: "again", revision: ended.snapshot.match.revision }), { ok: false, reason: "reset_used" });
});

test("command history replays moves, undo, actions, reset and enemy phase; altered evidence is rejected", () => {
  const initial = fixture(), session = new SequentialTurn(initial);
  const execute = (command: any) => { const result = session.execute({ ...command, revision: session.snapshot().match.revision }); assert.ok(result.ok); return result; };
  execute({ kind: "move", id: "m1", mech: "Assault", to: { x: 3, y: 2 } });
  execute({ kind: "undo", id: "u1" });
  execute({ kind: "move", id: "m2", mech: "Assault", to: { x: 3, y: 1 } });
  execute({ kind: "act", id: "a1", mech: "Assault", action: { kind: "charge", target: "boss" } });
  execute({ kind: "reset", id: "r1" });
  execute({ kind: "end", id: "e1", confirmUnused: true });
  const records = session.records();
  assert.equal(records.length, 6);
  assert.deepEqual(SequentialTurn.replay(initial, records).snapshot(), session.snapshot());
  const tampered = structuredClone(records); tampered[0]!.events = [];
  assert.throws(() => SequentialTurn.replay(initial, tampered), /invalid_sequential_replay/);
  const alteredStages = structuredClone(records); alteredStages[0]!.presentationStages!.afterPrepare.boss.hp--;
  assert.throws(() => SequentialTurn.replay(initial, alteredStages), /invalid_sequential_replay/);
  const alteredCause = structuredClone(records); const cause = alteredCause[1]!.causalEvent;
  assert.ok(cause && cause.kind === "undo_move"); cause.to.x++;
  assert.throws(() => SequentialTurn.replay(initial, alteredCause), /invalid_sequential_replay/);
  assert.throws(() => SequentialTurn.replay(initial, [...records, records[0]!]), /invalid_sequential_replay/);
  records[0]!.revision = -1;
  assert.notEqual(session.records()[0]!.revision, -1, "exported records cannot mutate the authority");
});

test("committed skip and terminal action publish explicit events", () => {
  const state = fixture(), session = new SequentialTurn(state);
  const skipped = session.execute({ kind: "act", id: "wait", revision: state.revision, mech: "Gunner", action: { kind: "skip" } });
  assert.ok(skipped.ok); assert.ok(skipped.events.some(e => e.type === "act" && e.action === "skip"));
  const doomed = fixture(); doomed.boss.hp = 1;
  const terminal = new SequentialTurn(doomed);
  const move = terminal.execute({ kind: "move", id: "m", revision: doomed.revision, mech: "Assault", to: { x: 3, y: 1 } }); assert.ok(move.ok);
  const hit = terminal.execute({ kind: "act", id: "a", revision: move.snapshot.match.revision, mech: "Assault", action: { kind: "charge", target: "boss" } });
  assert.ok(hit.ok); assert.equal(hit.snapshot.match.outcome, "victory");
  assert.ok(hit.events.some(e => e.type === "outcome" && e.outcome === "victory"));
});

test("replay rejects altered rights and state snapshots even when events are unchanged", () => {
  const initial = fixture(), session = new SequentialTurn(initial);
  const result = session.execute({ kind: "act", id: "a", revision: initial.revision, mech: "Gunner", action: { kind: "skip" } }); assert.ok(result.ok);
  const records = session.records(); records[0]!.snapshot.rights.Gunner.action = true;
  assert.throws(() => SequentialTurn.replay(initial, records), /invalid_sequential_replay/);
});

test("rescue victory occurs on the committed move without an enemy phase", () => {
  const state = fixture(); state.mission = { kind: "rescue:v1", target: { x: 3, y: 2 } };
  const session = new SequentialTurn(state);
  const moved = session.execute({ kind: "move", id: "rescue", revision: state.revision, mech: "Assault", to: { x: 3, y: 2 } });
  assert.ok(moved.ok); assert.equal(moved.snapshot.match.outcome, "victory"); assert.equal(moved.snapshot.match.phase, "finished");
  assert.deepEqual(moved.events.map(event => event.type), ["move", "outcome"]);
  assert.equal(session.canUndo(), false);
  assert.equal(session.execute({ kind: "end", id: "end", revision: moved.snapshot.match.revision, confirmUnused: true }).ok, false);
});

test("sequential review verifies committed commands and ignores events undone by reset", async () => {
  const { buildSequentialReview } = await import("../src/game/mecha/sequentialReview.ts");
  const initial = fixture();
  const session = new SequentialTurn(initial);
  const move = session.execute({ kind: "move", id: "m", revision: initial.revision, mech: "Assault", to: { x: 3, y: 2 } });
  assert.ok(move.ok);
  const reset = session.execute({ kind: "reset", id: "r", revision: move.snapshot.match.revision });
  assert.ok(reset.ok);
  const movedAgain = session.execute({ kind: "move", id: "m2", revision: reset.snapshot.match.revision, mech: "Assault", to: { x: 3, y: 1 } });
  assert.ok(movedAgain.ok);
  const attack = session.execute({ kind: "act", id: "a", revision: movedAgain.snapshot.match.revision, mech: "Assault", action: { kind: "charge", target: "boss" } });
  assert.ok(attack.ok);
  for (let index = 0; index < 20 && !session.snapshot().match.outcome; index++) {
    const result = session.execute({ kind: "end", id: `e${index}`, revision: session.snapshot().match.revision, confirmUnused: true });
    assert.ok(result.ok);
  }
  const final = session.snapshot().match;
  assert.ok(final.outcome);
  const records = session.records();
  const review = buildSequentialReview(initial, records, final);
  assert.equal(review.review.status, "verified");
  if (review.review.status === "verified") assert.ok(review.review.rounds[0]!.enemyDamage > 0);
  const altered = structuredClone(records);
  altered[0]!.events = [];
  assert.equal(buildSequentialReview(initial, altered, final).review.status, "unavailable");
});

test("sequential victory review verifies the rescue command and objectives", async () => {
  const { buildSequentialReview } = await import("../src/game/mecha/sequentialReview.ts");
  const initial = fixture();
  initial.mission = { kind: "rescue:v1", target: { x: 3, y: 2 } };
  const session = new SequentialTurn(initial);
  const result = session.execute({ kind: "move", id: "rescue", revision: initial.revision, mech: "Assault", to: { x: 3, y: 2 } });
  assert.ok(result.ok);
  const review = buildSequentialReview(initial, session.records(), result.snapshot.match);
  assert.equal(review.review.status, "verified");
  assert.deepEqual(review.achievements?.items.map(item => item.status), ["achieved", "not-applicable"]);
});

test("malformed commands fail before invoking accessors, serialization or rules", () => {
  const state = fixture(), session = new SequentialTurn(state), before = session.snapshot();
  let invoked = false;
  const malicious = { id: "malicious", revision: state.revision, get kind() { invoked = true; return "reset"; } };
  assert.deepEqual(session.execute(malicious as any), { ok: false, reason: "invalid_command" });
  assert.equal(invoked, false);
  const circular: any = { kind: "reset", id: "circular", revision: state.revision }; circular.extra = circular;
  assert.deepEqual(session.execute(circular), { ok: false, reason: "invalid_command" });
  assert.deepEqual(session.execute({ kind: "act", id: "bad", revision: state.revision, mech: "Gunner", action: { kind: "repair", target: "boss" } } as any), { ok: false, reason: "invalid_command" });
  assert.deepEqual(session.snapshot(), before);
});

test("local replay contains only anonymized commands and hashes and fails closed on tampering", async () => {
  const { createSequentialArchive, replaySequentialArchive } = await import("../src/game/mecha/sequentialReplay.ts");
  const initial = fixture(), session = new SequentialTurn(initial);
  let result = session.execute({ kind: "move", id: "private-command-id", revision: initial.revision, mech: "Assault", to: { x: 3, y: 1 } }); assert.ok(result.ok);
  result = session.execute({ kind: "act", id: "attack", revision: result.snapshot.match.revision, mech: "Assault", action: { kind: "charge", target: "boss" } }); assert.ok(result.ok);
  const raw = await createSequentialArchive(initial, session.records());
  assert.ok(!raw.includes("private-command-id")); assert.ok(!raw.includes('"snapshot"')); assert.ok(!raw.includes('"events"'));
  const restored = await replaySequentialArchive(initial, raw);
  assert.deepEqual(restored.snapshot(), session.snapshot());
  const changed = JSON.parse(raw); changed.entries[0].eventDigest = "0".repeat(64);
  await assert.rejects(replaySequentialArchive(initial, JSON.stringify(changed)), /invalid_sequential_archive/);
  const changedInitial = structuredClone(initial); changedInitial.boss.hp--;
  await assert.rejects(replaySequentialArchive(changedInitial, raw), /invalid_sequential_archive/);
  const extra = JSON.parse(raw); extra.extra = true;
  await assert.rejects(replaySequentialArchive(initial, JSON.stringify(extra)), /invalid_sequential_archive/);
  const malformed = JSON.parse(raw); malformed.entries[0].command = { kind: "act", id: "c0", revision: initial.revision, mech: "Assault" };
  await assert.rejects(replaySequentialArchive(initial, JSON.stringify(malformed)), /invalid_sequential_archive/);
  await assert.rejects(createSequentialArchive(initial, [...session.records(), session.records()[0]!]), /invalid_sequential_archive/);
});
