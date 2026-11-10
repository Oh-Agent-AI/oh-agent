import assert from "node:assert/strict";
import test from "node:test";
import { createDreamCityRemoteHostAdapter } from "../src/remote/city/DreamCityRemoteHostAdapter.ts";
import type { RemoteHostContext } from "../src/remote/RemoteHostAdapterRegistry.ts";

const context: RemoteHostContext = { appId: "city", capability: "city-dream:v1", sessionId: "dream-session", token: "a".repeat(64) };
const envelope = { schema: "dream-city-gzip:v1", plainBytes: 12, data: "H4sIAAAAAAAA" };
const request = (method: string, payload: Record<string, unknown>, peer?: Record<string, unknown>) => ({
  protocol: "app-remote:v1", appId: "city", sessionId: context.sessionId, capability: context.capability,
  type: "request", requestId: `req-${method.replaceAll(".", "-")}`, method, payload, ...(peer ? { peer } : {}),
});

test("Dream host serves its frozen Rust projection only to Relay-authenticated guests", () => {
  const messages: unknown[] = [];
  const lifecycle: unknown[] = [];
  const host = createDreamCityRemoteHostAdapter(context, { signal: new AbortController().signal,
    send: value => messages.push(value), lifecycle: value => lifecycle.push(value) });
  host.handle(request("dream.bootstrap", { projections: [{ id: "city-dream:v1", value: envelope }] }));
  assert.deepEqual(lifecycle, [{ type: "created" }]);

  const peer = { role: "guest", playerId: "guest", deviceId: "b".repeat(64) };
  host.handle(request("dream.snapshot", {}, peer));
  assert.deepEqual(messages.at(-1), { type: "response", requestId: "req-dream-snapshot", result: { ok: true, snapshot: envelope } });

  host.handle(request("dream.snapshot", {}, { role: "owner", playerId: "owner", deviceId: "c".repeat(64) }));
  assert.deepEqual(messages.at(-1), { type: "response", requestId: "req-dream-snapshot", result: { ok: false, error: { code: "unavailable" } } });
  host.close();
  host.handle(request("dream.snapshot", {}, peer));
  assert.deepEqual(messages.at(-1), { type: "response", requestId: "req-dream-snapshot", result: { ok: false, error: { code: "unavailable" } } });
});

test("Dream host rejects unprojected and expanded bootstrap payloads", () => {
  const messages: unknown[] = [];
  const host = createDreamCityRemoteHostAdapter(context, { signal: new AbortController().signal,
    send: value => messages.push(value), lifecycle: () => assert.fail("invalid bootstrap cannot create a session") });
  host.handle(request("dream.bootstrap", { projections: [{ id: "city-dream:v1", value: { ...envelope, path: "/private" } }] }));
  host.handle(request("dream.bootstrap", { projections: [{ id: "city-dream:v1", value: envelope }], model: { raw: true } }));
  assert.equal(messages.length, 2);
  assert.ok(messages.every(value => (value as { result?: { error?: { code?: string } } }).result?.error?.code === "invalid_plan"));
});
