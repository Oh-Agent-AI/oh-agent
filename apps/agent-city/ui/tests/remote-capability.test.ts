import { strict as assert } from "node:assert";
import { test } from "node:test";
import { remoteCapability, remoteStorageKey } from "../src/remote/remoteCapability.ts";

test("remote links default to v1 and explicitly negotiate only supported capabilities", () => {
  assert.equal(remoteCapability(new URLSearchParams()), "mecha:v1");
  assert.equal(remoteCapability(new URLSearchParams("capability=mecha%3Av1")), "mecha:v1");
  assert.equal(remoteCapability(new URLSearchParams("capability=mecha%3Av2")), "mecha:v2");
  assert.equal(remoteCapability(new URLSearchParams("capability=mecha%3Av3")), "mecha:v3");
  assert.equal(remoteCapability(new URLSearchParams("capability=mecha%3Av4")), "mecha:v4");
  for (const query of ["capability=", "capability=mecha%3Av5", "capability=mecha%3Av1&capability=mecha%3Av2", "capability=mecha%3Av2&capability=mecha%3Av2"]) {
    assert.equal(remoteCapability(new URLSearchParams(query)), null, query);
  }
});

test("v1 credentials keep their legacy key but cannot be reused by v2", () => {
  for (const kind of ["mecha-access", "mecha-guest"]) {
    assert.equal(remoteStorageKey(kind, "match-1", "mecha:v1"), `${kind}:match-1`);
    assert.notEqual(remoteStorageKey(kind, "match-1", "mecha:v2"), remoteStorageKey(kind, "match-1", "mecha:v1"));
    assert.notEqual(remoteStorageKey(kind, "match-1", "mecha:v3"), remoteStorageKey(kind, "match-1", "mecha:v2"));
    assert.notEqual(remoteStorageKey(kind, "match-1", "mecha:v4"), remoteStorageKey(kind, "match-1", "mecha:v3"));
  }
});
