import test from "node:test";
import assert from "node:assert/strict";
import { hasDuplicateJsonKeys } from "../src/jsonStrict.ts";

test("detects duplicate keys at every object depth, including escaped spellings", () => {
  assert.equal(hasDuplicateJsonKeys('{"a":1,"a":2}'), true);
  assert.equal(hasDuplicateJsonKeys('{"a":{"b":1,"b":2}}'), true);
  assert.equal(hasDuplicateJsonKeys('{"items":[{"x":1,"x":2}]}'), true);
  assert.equal(hasDuplicateJsonKeys('{"a":1,"\\u0061":2}'), true);
  assert.equal(hasDuplicateJsonKeys('{"a":{"b":1},"c":{"d":2}}'), false);
  assert.equal(hasDuplicateJsonKeys('{"a":"x,\\"a\\":1","b":[1,2,3]}'), false);
  assert.equal(hasDuplicateJsonKeys('[]'), false);
});

test("rejects malformed text instead of guessing", () => {
  assert.throws(() => hasDuplicateJsonKeys('{"a":1,'), /invalid JSON/);
  assert.throws(() => hasDuplicateJsonKeys('{"a":}'), /invalid JSON/);
});
