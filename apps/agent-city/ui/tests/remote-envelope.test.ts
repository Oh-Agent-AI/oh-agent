import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseRemoteEnvelope, remoteRequest } from "../src/remote/remoteEnvelope.ts";

test("generic envelopes preserve scope and enforce UTF-8 limits", () => {
  const scope = { appId: "island", sessionId: "session-1", capability: "racing:v1" };
  const request = remoteRequest(scope, "r1", "race.start", { name: "城市" });
  const data = JSON.stringify(request);
  const size = new TextEncoder().encode(data).length;
  assert.deepEqual(parseRemoteEnvelope(data, scope, size), request);
  assert.equal(parseRemoteEnvelope(data, scope, size - 1), null);
  for (const other of [{ ...scope, appId: "city" }, { ...scope, sessionId: "other" }, { ...scope, capability: "racing:v2" }]) {
    assert.equal(parseRemoteEnvelope(data, other, size), null);
  }
  assert.equal(parseRemoteEnvelope("{", scope, size), null);
});
