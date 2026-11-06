import { strict as assert } from "node:assert";
import { test } from "node:test";
import { REPLAY_AUTO_SAVE_KEY, readReplayAutoSave, readReplayAutoSaveStrict, writeReplayAutoSave } from "../src/game/mecha/replayAutoSave";

test("replay auto-save defaults on while preserving explicit opt-out", () => {
  const values = new Map<string, string>();
  const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  assert.equal(readReplayAutoSave(storage), true);
  values.set(REPLAY_AUTO_SAVE_KEY, "true");
  assert.equal(readReplayAutoSave(storage), false);
  writeReplayAutoSave(storage, true);
  assert.equal(readReplayAutoSave(storage), true);
  writeReplayAutoSave(storage, false);
  assert.equal(readReplayAutoSave(storage), false);
});

test("storage errors fail closed and unverified writes are rejected", () => {
  const unavailable = () => { throw new Error("denied"); };
  assert.equal(readReplayAutoSave(unavailable), false);
  assert.throws(() => readReplayAutoSaveStrict(unavailable));
  assert.throws(() => writeReplayAutoSave(unavailable, true));
  const noWrite = () => ({ getItem: () => null, setItem: () => {} });
  assert.throws(() => writeReplayAutoSave(noWrite, true));
});
