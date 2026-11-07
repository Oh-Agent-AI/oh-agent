import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SequentialMatchSession, restoreSequentialSnapshot } from "../src/game/mecha/session/SequentialMatchSession.ts";

function fixture() {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(state); return state;
}

test("a command session snapshots opening plus accepted commands and rejects stale revisions", () => {
  const initial = fixture();
  const session = new SequentialMatchSession("match-1", initial, []);
  const first = session.snapshot();
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(first.snapshot.revision, initial.revision);
  const move = session.submit(first.snapshot.revision, { kind: "move", id: "m1", revision: first.snapshot.revision, mech: "Assault", to: { x: 3, y: 2 } });
  assert.ok(move.ok);
  if (!move.ok) return;
  assert.equal(move.snapshot.commands.length, 1);
  assert.equal(session.submit(first.snapshot.revision, { kind: "move", id: "m2", revision: first.snapshot.revision, mech: "Gunner", to: { x: 1, y: 5 } }).ok, false);
  const restored = restoreSequentialSnapshot(move.snapshot);
  assert.deepEqual(restored.snapshot().match.mechs[0]!.pos, { x: 3, y: 2 });
  assert.equal(restored.snapshot().match.revision, move.snapshot.revision);
});

test("restoring a snapshot rejects a truncated command history", () => {
  const initial = fixture();
  const session = new SequentialMatchSession("match-2", initial, []);
  const before = session.snapshot();
  assert.ok(before.ok);
  if (!before.ok) return;
  const moved = session.submit(before.snapshot.revision, { kind: "move", id: "m", revision: before.snapshot.revision, mech: "Assault", to: { x: 3, y: 2 } });
  assert.ok(moved.ok);
  if (!moved.ok) return;
  const truncated = { ...moved.snapshot, commands: [] };
  assert.throws(() => restoreSequentialSnapshot(truncated), /invalid_sequential_snapshot_revision/);
});
