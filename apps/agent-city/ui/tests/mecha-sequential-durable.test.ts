import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SequentialDurableAuthority, type SequentialDurableStore } from "../src/game/mecha/sequentialDurable.ts";
import { SequentialTurn, type SequentialRecord } from "../src/game/mecha/sequentialTurn.ts";

function fixture() {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(state); return state;
}
const move = (revision: number) => ({ kind: "move" as const, id: "one", revision, mech: "Assault" as const, to: { x: 3, y: 2 } });

test("write-ahead commit locks input and publishes only after durable acknowledgement", async () => {
  const initial = fixture(); let release!: () => void, writes = 0, stored: SequentialRecord[] = [];
  const store: SequentialDurableStore = { async commit(revision, records) {
    assert.equal(revision, initial.revision); writes++; stored = structuredClone(records);
    await new Promise<void>(resolve => { release = resolve; });
  } };
  const session = new SequentialDurableAuthority(initial, [], store);
  const pending = session.execute(move(initial.revision));
  assert.deepEqual(session.snapshot().match, initial);
  assert.deepEqual(await session.execute({ kind: "end", id: "two", revision: initial.revision, confirmUnused: true }), { ok: false, reason: "busy" });
  release(); const result = await pending; assert.ok(result.ok);
  assert.deepEqual(session.snapshot(), SequentialTurn.replay(initial, stored).snapshot());
  assert.deepEqual(await session.execute(move(initial.revision)), result); assert.equal(writes, 1);
});

test("uncertain storage freezes authority until independently reconstructed from committed records", async () => {
  const initial = fixture(); let stored: SequentialRecord[] = [];
  const store: SequentialDurableStore = { async commit(_revision, records) { stored = structuredClone(records); throw new Error("ack lost"); } };
  const session = new SequentialDurableAuthority(initial, [], store);
  assert.deepEqual(await session.execute(move(initial.revision)), { ok: false, reason: "storage_unconfirmed" });
  assert.deepEqual(session.snapshot().match, initial); assert.equal(session.needsReload(), true);
  assert.deepEqual(await session.execute(move(initial.revision)), { ok: false, reason: "storage_unconfirmed" });
  let writes = 0;
  const recovered = new SequentialDurableAuthority(initial, stored, { async commit() { writes++; } });
  assert.deepEqual(recovered.snapshot().match.mechs[0]!.pos, { x: 3, y: 2 });
  assert.equal(recovered.snapshot().rights.Assault.move, false);
  assert.ok((await recovered.execute(move(initial.revision))).ok); assert.equal(writes, 0, "retry after reload cannot commit twice");
  const undone = await recovered.execute({ kind: "undo", id: "undo", revision: recovered.snapshot().match.revision });
  assert.ok(undone.ok); assert.deepEqual(undone.snapshot.match.mechs[0]!.pos, initial.mechs[0]!.pos);
});

test("invalid or stale command does not write and leaves session usable", async () => {
  const initial = fixture(); let writes = 0;
  const session = new SequentialDurableAuthority(initial, [], { async commit() { writes++; } });
  assert.deepEqual(await session.execute(move(initial.revision - 1)), { ok: false, reason: "stale_revision" });
  assert.equal(writes, 0); assert.equal(session.needsReload(), false);
  assert.ok((await session.execute(move(initial.revision))).ok); assert.equal(writes, 1);
});
