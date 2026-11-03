import assert from "node:assert/strict";
import test from "node:test";
import { pendingJournal, type PendingMarker } from "../src/remote/pendingJournal.ts";

const identity = { matchId: "match-1", playerId: "owner", capability: "mecha:v3", room: "room-1", invite: "", device: "device-1" };
const marker: PendingMarker = { version: 1, kind: "plan", matchId: "match-1", playerId: "owner", commandId: "cmd-1", baseRevision: 0 };
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test("journal persists only bounded command identity and isolates room, capability and player", () => {
  const mem = storage(); const journal = pendingJournal(mem, identity);
  assert.deepEqual(journal.read(), { status: "empty" });
  assert.equal(journal.begin(marker), true); assert.equal(journal.begin(marker), false);
  assert.deepEqual(journal.read(), { status: "pending", marker });
  assert.equal(mem.values.size, 1); assert.deepEqual(JSON.parse([...mem.values.values()][0]!), marker);
  for (const change of [{ room: "room-2" }, { capability: "mecha:v2" }, { playerId: "guest" }, { device: "device-2" }]) {
    assert.equal(pendingJournal(mem, { ...identity, ...change }).read().status, "empty");
  }
  assert.equal(journal.clear({ ...marker, commandId: "wrong" }), false);
  assert.equal(journal.clear(marker), true); assert.equal(journal.read().status, "empty");
});

test("invalid, extra-field, unavailable and unwritable storage fails closed", () => {
  const mem = storage(); const journal = pendingJournal(mem, identity);
  assert.equal(journal.begin(marker), true); const key = [...mem.values.keys()][0]!;
  for (const bad of ["{", JSON.stringify({ ...marker, prompt: "must not be persisted" }), JSON.stringify({ ...marker, playerId: "guest" }), JSON.stringify({ ...marker, baseRevision: -1 }), "x".repeat(1025)]) {
    mem.values.set(key, bad); assert.equal(journal.read().status, "error"); assert.equal(journal.begin(marker), false); assert.equal(journal.clear(marker), false);
  }
  assert.equal(pendingJournal(null, identity).read().status, "error");
  const unwritable = { ...storage(), setItem: () => { throw new Error("quota"); } };
  assert.equal(pendingJournal(unwritable, identity).begin(marker), false);
  const unableToRemove = { ...storage(), removeItem: () => { throw new Error("blocked"); } };
  const blocked = pendingJournal(unableToRemove, identity); assert.equal(blocked.begin(marker), true); assert.equal(blocked.clear(marker), false); assert.equal(blocked.read().status, "pending");
});
