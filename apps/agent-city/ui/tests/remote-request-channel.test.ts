import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteRequestChannel, type RemoteSocket } from "../src/remote/RemoteRequestChannel.ts";
import { remoteRequest } from "../src/remote/remoteEnvelope.ts";

const scope = { appId: "city", sessionId: "session-1", capability: "mecha:v4" };
const envelopeScope = { protocol: "app-remote:v1", ...scope };

class FakeSocket implements RemoteSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = 3;
    this.emit("close", {});
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type: string, event: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  receive(value: unknown): void { this.emit("message", { data: JSON.stringify(value) }); }
  request(index = 0): Record<string, unknown> { return JSON.parse(this.sent[index]) as Record<string, unknown>; }
}

test("abort rejects the pending request and frees its capacity", async () => {
  const socket = new FakeSocket();
  const channel = new RemoteRequestChannel(socket, scope, 4096, 1000, undefined, undefined, 1);
  const abort = new AbortController();
  const pending = channel.request("test.abort", {}, abort.signal);
  abort.abort();
  await assert.rejects(pending, /remote_cancelled/);

  const next = channel.request("test.next", {});
  socket.receive({ ...envelopeScope, type: "response", requestId: socket.request(1).requestId, result: { ok: true } });
  assert.deepEqual(await next, { ok: true });
});

test("timeout rejects and a late response is ignored by the application listener", async () => {
  const socket = new FakeSocket();
  const messages: Record<string, unknown>[] = [];
  const channel = new RemoteRequestChannel(socket, scope, 4096, 5, undefined, message => messages.push(message));
  const pending = channel.request("test.timeout", {});
  await assert.rejects(pending, /remote_timeout/);
  socket.receive({ ...envelopeScope, type: "response", requestId: socket.request().requestId, result: { ok: true } });
  assert.deepEqual(messages, []);
});

test("close and error invalidate pending requests exactly once", async () => {
  for (const eventType of ["close", "error"]) {
    const socket = new FakeSocket();
    let invalidations = 0;
    const channel = new RemoteRequestChannel(socket, scope, 4096, 1000, () => { invalidations++; });
    const pending = channel.request("test.disconnect", {});
    socket.emit(eventType);
    await assert.rejects(pending, /remote_disconnected/);
    channel.invalidate();
    assert.equal(invalidations, 1, `${eventType} invalidates once`);
  }
});

test("scope mismatch closes the socket and rejects the pending request", async () => {
  const socket = new FakeSocket();
  let invalidations = 0;
  const channel = new RemoteRequestChannel(socket, scope, 4096, 1000, () => { invalidations++; });
  const pending = channel.request("test.scope", {});
  socket.receive({ ...envelopeScope, capability: "mecha:v1", type: "response", requestId: socket.request().requestId, result: {} });
  await assert.rejects(pending, /remote_disconnected/);
  assert.deepEqual(socket.closed, [{ code: 1008, reason: "invalid_remote_envelope" }]);
  assert.equal(invalidations, 1);
});

test("unknown and duplicate responses are dropped instead of reaching onMessage", async () => {
  const socket = new FakeSocket();
  const messages: Record<string, unknown>[] = [];
  const channel = new RemoteRequestChannel(socket, scope, 4096, 1000, undefined, message => messages.push(message));
  const pending = channel.request("test.response", {});
  const requestId = socket.request().requestId;
  const response = { ...envelopeScope, type: "response", requestId, result: { ok: true } };
  socket.receive({ ...response, requestId: "unknown-id" });
  socket.receive(response);
  socket.receive(response);
  const event = { ...envelopeScope, type: "event", event: { type: "test.event" } };
  socket.receive(event);
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(messages, [event]);
});

test("request payloads are measured in UTF-8 bytes before sending", async () => {
  const socket = new FakeSocket();
  const sample = JSON.stringify(remoteRequest(scope, "remote-1", "test.utf8", { text: "城市城市" }));
  const limit = new TextEncoder().encode(sample).byteLength - 1;
  const channel = new RemoteRequestChannel(socket, scope, limit);
  await assert.rejects(channel.request("test.utf8", { text: "城市城市" }), /remote_message_too_large/);
  assert.equal(socket.sent.length, 0);
});

test("maximum in-flight requests apply backpressure and recover when a request settles", async () => {
  const socket = new FakeSocket();
  const channel = new RemoteRequestChannel(socket, scope, 4096, 1000, undefined, undefined, 1);
  const first = channel.request("test.first", {});
  await assert.rejects(channel.request("test.second", {}), /remote_backpressure/);
  assert.equal(socket.sent.length, 1);
  socket.receive({ ...envelopeScope, type: "response", requestId: socket.request().requestId, result: "first-result" });
  assert.equal(await first, "first-result");

  const second = channel.request("test.second", {});
  socket.receive({ ...envelopeScope, type: "response", requestId: socket.request(1).requestId, result: "second-result" });
  assert.equal(await second, "second-result");
  assert.throws(() => new RemoteRequestChannel(socket, scope, 4096, 1000, undefined, undefined, 0), /remote_max_in_flight_invalid/);
});
