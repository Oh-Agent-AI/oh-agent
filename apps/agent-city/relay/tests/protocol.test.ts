import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL, hostMessage, parseCapability, requestPeer, secretHash } from "../protocol.ts";

const scope = { appId: "island", sessionId: "s1", capability: { id: "island:v1", methods: ["island.visit"], events: ["island.changed"] } };
const envelope = { protocol: PROTOCOL, appId: scope.appId, sessionId: scope.sessionId, capability: scope.capability.id };

test("ticket secrets use independent hashes", async () => {
  const hash = await secretHash("a".repeat(64));
  assert.equal(hash.length, 64);
  assert.notEqual(hash, "a".repeat(64));
  assert.equal(await secretHash("a".repeat(64)), hash);
});

test("requests and events are scoped to a registered capability", () => {
  const request = { ...envelope, type: "request", requestId: "r1", method: "island.visit", payload: {} };
  assert.equal(requestPeer(request, scope), null);
  assert.equal(requestPeer({ ...request, appId: "city" }, scope), "forbidden");
  assert.equal(requestPeer({ ...request, sessionId: "other" }, scope), "forbidden");
  assert.equal(requestPeer({ ...request, capability: "mecha:v1" }, scope), "forbidden");
  assert.equal(requestPeer({ ...request, method: "plugin_request" }, scope), "invalid_message");
  assert.equal(hostMessage({ ...envelope, type: "response", requestId: "r1" }, scope), true);
  assert.equal(hostMessage({ ...envelope, type: "response", requestId: 1 }, scope), false);
  assert.equal(hostMessage({ ...envelope, type: "event", event: { type: "island.changed" } }, scope), true);
  assert.equal(hostMessage({ ...envelope, type: "event", event: { type: "match.closed" } }, scope), false);
  assert.equal(hostMessage({ ...envelope, appId: "city", type: "event", event: { type: "island.changed" } }, scope), false);
});

test("capability definitions are bounded and unambiguous", () => {
  assert.deepEqual(parseCapability(scope.capability), scope.capability);
  assert.equal(parseCapability({ ...scope.capability, methods: ["island.visit", "island.visit"] }), null);
  assert.equal(parseCapability({ ...scope.capability, methods: ["../unsafe"] }), null);
  assert.equal(parseCapability({ ...scope.capability, methods: [] }), null);
});
