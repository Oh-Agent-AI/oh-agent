import assert from "node:assert/strict";
import test from "node:test";
import { RemoteHostAdapterRegistry, resolveRemoteHostAdapter } from "../src/remote/RemoteHostAdapterRegistry.ts";
import { startRemoteHostRuntime } from "../src/remote/RemoteHostRuntime.ts";

test("host adapter registry routes same method names by app and capability", async () => {
  const registry = new RemoteHostAdapterRegistry();
  const delivered: string[] = [];
  registry.register({ appId: "city", capability: "mecha:v4", handle: request => delivered.push(`mecha:${request.method}`) });
  registry.register({ appId: "island", capability: "island:v1", handle: request => delivered.push(`island:${request.method}`) });
  const mechaScope = { token: "token-a", appId: "city", capability: "mecha:v4", sessionId: "session-a" };
  const islandScope = { token: "token-b", appId: "island", capability: "island:v1", sessionId: "session-b" };
  const requestFor = (scope: { appId: string; capability: string; sessionId: string }) => ({ protocol: "app-remote:v1", appId: scope.appId, sessionId: scope.sessionId, capability: scope.capability, type: "request", requestId: "r1", method: "scene.snapshot", payload: {} });
  assert.equal(await registry.dispatch({ ...mechaScope, request: requestFor(mechaScope) }, mechaScope), true);
  assert.equal(await registry.dispatch({ ...islandScope, request: requestFor(islandScope) }, islandScope), true);
  assert.deepEqual(delivered, ["mecha:scene.snapshot", "island:scene.snapshot"]);
});

test("host adapter registry rejects cross-instance, unknown and duplicate scopes", async () => {
  const registry = new RemoteHostAdapterRegistry();
  let calls = 0;
  const adapter = { appId: "city", capability: "mecha:v4", handle: () => { calls += 1; } };
  registry.register(adapter);
  assert.throws(() => registry.register(adapter), /remote_host_adapter_duplicate/);
  const expected = { token: "token-a", appId: "city", capability: "mecha:v4", sessionId: "session-a" };
  const request = { protocol: "app-remote:v1", appId: expected.appId, sessionId: expected.sessionId, capability: expected.capability, type: "request", requestId: "r1", method: "scene.snapshot", payload: {} };
  assert.equal(await registry.dispatch({ ...expected, sessionId: "session-b", request }, expected), false);
  assert.equal(await registry.dispatch({ ...expected, capability: "other:v1", request }, expected), false);
  assert.equal(await registry.dispatch({ ...expected, token: "other-token", request }, expected), false);
  assert.equal(await registry.dispatch({ ...expected, request: { ...request, type: "event" } }, expected), false);
  assert.equal(calls, 0);
});

test("host adapter receives only validated relay-injected peer context", async () => {
  const registry = new RemoteHostAdapterRegistry();
  const peers: unknown[] = [];
  const scope = { token: "token-a", appId: "city", capability: "city-dream:v1", sessionId: "dream-session" };
  registry.register({ appId: scope.appId, capability: scope.capability, handle: request => { peers.push(request.peer); } });
  const makeMessage = (peer: unknown) => ({ ...scope, request: { protocol: "app-remote:v1", appId: scope.appId, sessionId: scope.sessionId,
    capability: scope.capability, type: "request", requestId: "r1", method: "dream.snapshot", payload: {}, peer } });

  assert.equal(await registry.dispatch(makeMessage({ role: "guest", playerId: "guest", deviceId: "a".repeat(64) }), scope), true);
  assert.deepEqual(peers, [{ role: "guest", playerId: "guest", deviceId: "a".repeat(64) }]);
  assert.equal(await registry.dispatch(makeMessage({ role: "guest", playerId: "guest", deviceId: "not-an-opaque-device" }), scope), false);
  assert.equal(await registry.dispatch(makeMessage({ role: "host", playerId: "host" }), scope), false);
  assert.equal(await registry.dispatch(makeMessage({ role: "guest", playerId: "guest", machinePath: "/private" }), scope), false);
  assert.equal(peers.length, 1, "invalid or expanded identity metadata is never delivered to an adapter");
});

test("host adapter registry serializes async requests and contains rejected handlers", async () => {
  const registry = new RemoteHostAdapterRegistry();
  const delivered: string[] = [];
  const errors: string[] = [];
  const scope = { token: "token-a", appId: "island", capability: "island:v1", sessionId: "session-a" };
  let releaseFirst!: () => void;
  registry.register({ appId: "island", capability: "island:v1", handle: async request => {
    delivered.push(`start:${request.requestId}`);
    if (request.requestId === "first") await new Promise<void>(resolve => { releaseFirst = resolve; });
    if (request.requestId === "reject") throw new Error("private adapter detail");
    delivered.push(`end:${request.requestId}`);
  }, onError: (_request, code) => errors.push(code) });
  const message = (requestId: string) => ({ ...scope, request: { protocol: "app-remote:v1", appId: scope.appId, sessionId: scope.sessionId,
    capability: scope.capability, type: "request", requestId, method: "scene.snapshot", payload: {} } });
  const first = registry.dispatch(message("first"), scope);
  const second = registry.dispatch(message("second"), scope);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delivered, ["start:first"], "later work waits behind an async operation");
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(delivered, ["start:first", "end:first", "start:second", "end:second"]);
  assert.equal(await registry.dispatch(message("reject"), scope), true);
  assert.deepEqual(errors, ["unavailable"], "adapter exceptions are converted into a stable error class");
  registry.close();
  assert.equal(await registry.dispatch(message("closed"), scope), false);
});

test("host manifest resolves exact scope and rejects unknown or ambiguous adapters", () => {
  const mecha = { appId: "city", capability: "mecha:v4", create: () => ({ appId: "city", capability: "mecha:v4", handle() {} }) };
  const island = { appId: "island", capability: "island:v1", create: () => ({ appId: "island", capability: "island:v1", handle() {} }) };
  assert.equal(resolveRemoteHostAdapter({ appId: "island", capability: "island:v1" }, [mecha, island]), island);
  assert.equal(resolveRemoteHostAdapter({ appId: "city", capability: "mecha:v3" }, [mecha, island]), null);
  assert.equal(resolveRemoteHostAdapter({ appId: "city", capability: "mecha:v4" }, [mecha, mecha]), null);
});

test("generic host runtime binds lifecycle and request handling to injected session context", async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const listeners = new Map<string, (event: any) => void>();
  const replies: Array<Record<string, unknown>> = [];
  const bridge = {
    __AV_REMOTE_HOST_CONTEXT__: { token: "a".repeat(64), appId: "island", capability: "island:v1", sessionId: "session-b" },
    __TAURI__: { core: { invoke: (_command: string, args: { reply: Record<string, unknown> }) => { replies.push(args.reply); return Promise.resolve(); } } },
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  Object.defineProperty(globalThis, "window", { value: bridge, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: { body: { textContent: "" } }, configurable: true, writable: true });
  let handled = 0;
  let closed = 0;
  let signal: AbortSignal | null = null;
  const close = startRemoteHostRuntime([{ appId: "island", capability: "island:v1", create: (_context, services) => {
    signal = services.signal;
    return { appId: "island", capability: "island:v1", handle: request => { handled += 1; services.send({ type: "response", requestId: request.requestId }); }, close: () => { closed += 1; } };
  } }]);
  try {
    assert.equal(replies[0]?.type, "ready");
    const event = listeners.get("__AV_REMOTE_HOST_REQUEST__")!;
    const scope = bridge.__AV_REMOTE_HOST_CONTEXT__;
    const request = { protocol: "app-remote:v1", appId: scope.appId, sessionId: scope.sessionId, capability: scope.capability, type: "request", requestId: "req-1", method: "scene.snapshot", payload: {} };
    event({ detail: { ...scope, request } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(handled, 1);
    assert.equal(replies.at(-1)?.type, "message");
    event({ detail: { ...scope, sessionId: "different-session", request } });
    assert.equal(handled, 1);
    close(); close();
    assert.equal(closed, 1);
    assert.equal(signal?.aborted, true, "runtime shutdown cancels adapter-owned async work");
    assert.equal(listeners.has("__AV_REMOTE_HOST_REQUEST__"), false);
  } finally {
    close();
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true, writable: true });
  }
});

test("async adapter startup gates ready and close suppresses late async replies", async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const listeners = new Map<string, (event: any) => void>();
  const replies: Array<Record<string, unknown>> = [];
  const bridge = {
    __AV_REMOTE_HOST_CONTEXT__: { token: "b".repeat(64), appId: "island", capability: "island:v1", sessionId: "async-session" },
    __TAURI__: { core: { invoke: (_command: string, args: { reply: Record<string, unknown> }) => { replies.push(args.reply); return Promise.resolve(); } } },
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  Object.defineProperty(globalThis, "window", { value: bridge, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: { body: { textContent: "" } }, configurable: true, writable: true });
  let finishStart!: () => void;
  let finishRequest!: () => void;
  let signal: AbortSignal | null = null;
  const close = startRemoteHostRuntime([{ appId: "island", capability: "island:v1", create: (_context, services) => ({
    appId: "island", capability: "island:v1",
    start: async value => { signal = value; await new Promise<void>(resolve => { finishStart = resolve; }); },
    handle: async request => { await new Promise<void>(resolve => { finishRequest = resolve; }); services.send({ type: "response", requestId: request.requestId }); },
  }) }]);
  try {
    assert.equal(replies.some(reply => reply.type === "ready"), false, "ready waits for async host initialization");
    finishStart();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.at(-1)?.type, "ready");
    const scope = bridge.__AV_REMOTE_HOST_CONTEXT__;
    listeners.get("__AV_REMOTE_HOST_REQUEST__")!({ detail: { ...scope, request: {
      protocol: "app-remote:v1", appId: scope.appId, sessionId: scope.sessionId, capability: scope.capability,
      type: "request", requestId: "late-response", method: "scene.snapshot", payload: {},
    } } });
    await new Promise(resolve => setImmediate(resolve));
    close();
    finishRequest();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal?.aborted, true);
    assert.equal(replies.some(reply => reply.type === "message" && JSON.stringify(reply).includes("late-response")), false);
    assert.equal(listeners.has("__AV_REMOTE_HOST_REQUEST__"), false);
  } finally {
    close();
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true, writable: true });
  }
});
