import test from "node:test";
import assert from "node:assert/strict";
import { digest, errorCode } from "../src/adapters/creatorHostUtils.ts";

test("creator host errors expose only bounded host codes", () => {
  assert.equal(errorCode(new Error("revision_conflict"), "creator_request_failed"), "revision_conflict");
  assert.equal(errorCode(new Error("details must stay local"), "creator_request_failed"), "creator_request_failed");
  assert.equal(errorCode(undefined, "creator_request_failed"), "creator_request_failed");
});

test("creator request digests use canonical JSON", async () => {
  const first = await digest({ b: 2, a: 1 });
  assert.equal(first, await digest({ a: 1, b: 2 }));
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(await digest({ a: 1, b: 3 }), first);
});
