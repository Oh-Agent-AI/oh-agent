import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasVerifiedReplaySave } from "../src/game/mecha/replayPersistenceGuard";

test("only an unchanged saved record of this match suppresses the loss warning", () => {
  const first = {}, second = {};
  const values = new Map([["a", "original"], ["b", "second"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null };
  const saved = [{ match: first, key: "a", raw: "original" }, { match: first, key: "b", raw: "second" }];
  assert.equal(hasVerifiedReplaySave(first, saved, storage), true);
  assert.equal(hasVerifiedReplaySave(second, saved, storage), false);
  values.delete("a");
  assert.equal(hasVerifiedReplaySave(first, saved, storage), true, "another valid save still counts");
  values.set("b", "modified");
  assert.equal(hasVerifiedReplaySave(first, saved, storage), false);
  assert.equal(hasVerifiedReplaySave(first, saved, { getItem: () => { throw new Error("storage denied"); } }), false);
});
