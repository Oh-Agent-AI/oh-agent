import assert from "node:assert/strict";
import test from "node:test";
import { RemoteMatchClient, type WebSocketLike } from "../src/game/mecha/client/RemoteMatchClient.ts";
import { startRemoteSessionHost } from "../src/remote/RemoteSessionHost.ts";
import { MECHA_NET_PROTOCOL, type MatchSnapshot } from "../src/game/mecha/contracts/match.ts";
import { parseRemoteMessage, snapshotResult } from "../src/game/mecha/contracts/transport.ts";
import { remoteArenaFromSite, pveMatchFromArena } from "../src/game/mecha/contracts/arena.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";

class FakeSocket implements WebSocketLike {
  readonly listeners = new Map<string, Array<(event: never) => void>>();
  sent: string[] = [];
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.emit("close", {} as never); }
  emit(type: string, event: never) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  respond(result: unknown) {
    const request = JSON.parse(this.sent.at(-1)!);
    this.emit("message", { data: JSON.stringify({ protocol: "app-remote:v1", appId: "city", sessionId: request.sessionId, capability: "mecha:v1", type: "response", requestId: request.requestId, result }) } as never);
  }
}

const terrain = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const));
const heights = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0));
const site: CityMechaSite = {
  originX: 0, originZ: 0, yaw: 0, cellW: 8, cellD: 8, terrain, heights, buildings: [], blocked: [],
  mechs: [{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 5, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }],
  boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
};
const arena = remoteArenaFromSite(site, { arenaId: "arena-1", sourceRevision: "revision-1" });
const snapshot: MatchSnapshot = {
  protocol: MECHA_NET_PROTOCOL, matchId: "match-1", mode: "pve", ruleset: "mecha-v1.4", status: "active", revision: 1,
  players: [{ playerId: "owner", side: "A", role: "host" }], arena,
  state: pveMatchFromArena(arena, { script: "stationary_smash" }),
};

async function waitForRequest(socket: FakeSocket) {
  for (let attempt = 0; attempt < 20 && socket.sent.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(socket.sent.length, 1);
}

test("remote client correlates responses and validates snapshots", async () => {
  const socket = new FakeSocket();
  const client = new RemoteMatchClient({ url: "wss://example.test/room", playerId: "owner", socketFactory: () => { queueMicrotask(() => socket.emit("open", {} as never)); return socket; } });
  const pending = client.snapshot("match-1");
  socket.emit("open", {} as never);
  await waitForRequest(socket);
  socket.respond({ ok: true, value: snapshot });
  assert.deepEqual(await pending, { ok: true, value: snapshot });
  client.dispose();
});

test("remote client ignores messages from another app, session or capability", async () => {
  const socket = new FakeSocket();
  const client = new RemoteMatchClient({ url: "wss://example.test/room", playerId: "owner", socketFactory: () => { queueMicrotask(() => socket.emit("open", {} as never)); return socket; } });
  const pending = client.snapshot("match-1");
  await waitForRequest(socket);
  const request = JSON.parse(socket.sent[0]);
  assert.equal(request.protocol, "app-remote:v1");
  const response = { protocol: "app-remote:v1", appId: "city", sessionId: "match-1", capability: "mecha:v1", type: "response", requestId: request.requestId, result: { ok: true, value: snapshot } };
  for (const wrong of [{ appId: "island" }, { sessionId: "other" }, { capability: "island:v1" }]) {
    socket.emit("message", { data: JSON.stringify({ ...response, ...wrong, result: { ok: false, error: { code: "forbidden" } } }) } as never);
  }
  socket.respond({ ok: true, value: snapshot });
  assert.deepEqual(await pending, { ok: true, value: snapshot });
  await assert.rejects(client.snapshot("other"), /match_not_found/);
  client.dispose();
});

test("remote client rejects malformed successful responses", async () => {
  const socket = new FakeSocket();
  const client = new RemoteMatchClient({ url: "wss://example.test/room", playerId: "owner", socketFactory: () => { queueMicrotask(() => socket.emit("open", {} as never)); return socket; } });
  const pending = client.snapshot("match-1");
  socket.emit("open", {} as never);
  await waitForRequest(socket);
  socket.respond({ ok: true, value: { nope: true } });
  assert.deepEqual(await pending, { ok: false, error: { code: "invalid_message" } });
  client.dispose();
});

test("reconnect exchanges the device credential for a fresh one-time ticket", async () => {
  const sockets: FakeSocket[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ ok: true, ticket: "fresh-ticket" });
  };
  try {
    const client = new RemoteMatchClient({
      url: "wss://example.test/room?ticket=expired", playerId: "owner",
      socketFactory: (url) => {
        assert.equal(new URL(url).searchParams.get("ticket"), "fresh-ticket");
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open", {} as never));
        return socket;
      },
      reconnect: { url: "https://example.test/access", deviceId: "device-1", token: "reconnect-secret" },
    });
    const pending = client.snapshot("match-1");
    for (let attempt = 0; attempt < 20 && sockets.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sockets.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init?.headers && new Headers(requests[0].init.headers).get("Authorization"), "Bearer reconnect-secret");
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { action: "pair", deviceId: "device-1" });
    sockets[0].emit("open", {} as never);
    await waitForRequest(sockets[0]);
    sockets[0].respond({ ok: true, value: snapshot });
    assert.equal((await pending).ok, true);
    client.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disconnect automatically obtains a fresh ticket and resynchronizes", async () => {
  const sockets: FakeSocket[] = [];
  const tickets: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ticket: `ticket-${tickets.length + 1}` });
  const client = new RemoteMatchClient({
    url: "wss://example.test/room", playerId: "owner",
    reconnect: { url: "https://example.test/access", deviceId: "device-1", token: "secret" },
    socketFactory: (url) => {
      tickets.push(new URL(url).searchParams.get("ticket")!);
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit("open", {} as never));
      return socket;
    },
  });
  const events: unknown[] = [];
  client.subscribe((event) => events.push(event));
  try {
    const initial = client.snapshot("match-1");
    for (let attempt = 0; attempt < 100 && sockets.length < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await waitForRequest(sockets[0]!);
    sockets[0]!.respond({ ok: true, value: snapshot });
    assert.equal((await initial).ok, true);
    sockets[0]!.close();
    for (let attempt = 0; attempt < 200 && sockets.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sockets.length, 2);
    await waitForRequest(sockets[1]!);
    assert.equal(JSON.parse(sockets[1]!.sent[0]).method, "match.snapshot");
    sockets[1]!.respond({ ok: true, value: snapshot });
    for (let attempt = 0; attempt < 100 && events.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(tickets, ["ticket-1", "ticket-2"]);
    assert.deepEqual(events, [{ type: "match.replaced", snapshot }]);
  } finally {
    client.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("session host authenticates handshake and only accepts the matching token", () => {
  const originalWindow = globalThis.window;
  const replies: unknown[] = [];
  let listener: ((event: { detail: unknown }) => void) | undefined;
  const host = {
    __AV_MECHA_SESSION_TOKEN__: "session-secret",
    __TAURI__: { core: { invoke: (_command: string, args: { reply: unknown }) => { replies.push(args.reply); return Promise.resolve(); } } },
    addEventListener: (_type: string, handler: (event: { detail: unknown }) => void) => { listener = handler; },
  };
  Object.defineProperty(globalThis, "window", { value: host, configurable: true, writable: true });
  try {
    startRemoteSessionHost();
    assert.deepEqual(replies, [{ type: "ready", token: "session-secret" }]);
    const request = { protocol: MECHA_NET_PROTOCOL, type: "request", requestId: "create-session", method: "match.create", payload: { config: { matchId: "match-1", mode: "pve", arena, state: snapshot.state, players: snapshot.players } } };
    listener!({ detail: { token: "wrong", request } });
    assert.equal(replies.length, 1);
    listener!({ detail: { token: "session-secret", request } });
    assert.deepEqual(replies.at(-1), { type: "created", token: "session-secret" });
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
  }
});

test("transport parsers reject invalid errors and revision mismatches", () => {
  assert.equal(parseRemoteMessage({ protocol: "other", type: "response", requestId: "1", result: {} }), null);
  assert.equal(parseRemoteMessage({ protocol: MECHA_NET_PROTOCOL, type: "event", event: { type: "turn.resolved", result: {} } }), null);
  assert.equal(parseRemoteMessage({ protocol: MECHA_NET_PROTOCOL, type: "event", event: { type: "match.replaced", snapshot: {} } }), null);
  assert.equal(parseRemoteMessage({ protocol: MECHA_NET_PROTOCOL, type: "event", event: { type: "match.closed", matchId: "match-1", revision: -1 } }), null);
  assert.equal(parseRemoteMessage({ protocol: MECHA_NET_PROTOCOL, type: "event", event: { type: "unknown" } }), null);
  assert.ok(parseRemoteMessage({ protocol: MECHA_NET_PROTOCOL, type: "event", event: { type: "match.replaced", snapshot } }));
  assert.equal(snapshotResult({ ok: false, error: { code: "not_a_code" } }), null);
  assert.equal(snapshotResult({ ok: true, value: { ...snapshot, revision: 99 } }), null);
  assert.deepEqual(snapshotResult({ ok: false, error: { code: "host_offline" } }), { ok: false, error: { code: "host_offline" } });
});

test("late events from a disconnected socket are ignored after reconnect", async () => {
  const sockets: FakeSocket[] = [];
  const client = new RemoteMatchClient({ url: "wss://example.test/room", playerId: "owner", socketFactory: () => {
    const socket = new FakeSocket(); sockets.push(socket); queueMicrotask(() => socket.emit("open", {} as never)); return socket;
  } });
  const events: unknown[] = [];
  client.subscribe((event) => events.push(event));
  const first = client.snapshot("match-1"); await new Promise((resolve) => setTimeout(resolve, 0)); await waitForRequest(sockets[0]); sockets[0].respond({ ok: true, value: snapshot }); await first;
  sockets[0].close();
  const second = client.snapshot("match-1"); await new Promise((resolve) => setTimeout(resolve, 0)); await waitForRequest(sockets[1]); sockets[1].respond({ ok: true, value: snapshot }); await second;
  sockets[0].emit("message", { data: JSON.stringify({ protocol: "app-remote:v1", appId: "city", sessionId: "match-1", capability: "mecha:v1", type: "event", event: { type: "match.replaced", snapshot } }) } as never);
  assert.deepEqual(events, []); client.dispose();
});

test("socket that failed before opening cannot become online later", async () => {
  const socket = new FakeSocket(), statuses: string[] = [];
  const client = new RemoteMatchClient({ url: "wss://example.test/room", playerId: "owner", socketFactory: () => socket });
  client.onStatus((state) => statuses.push(state));
  const pending = client.snapshot("match-1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.emit("error", {} as never);
  await assert.rejects(pending, /host_offline/);
  socket.emit("open", {} as never);
  assert.equal(statuses.at(-1), "offline"); assert.equal(statuses.includes("online"), false);
  client.dispose();
});


test("prepared v2 client isolates responses from v1", async () => {
  const socket = new FakeSocket();
  const client = new RemoteMatchClient({ url: "wss://example.test/room", playerId: "owner", capability: "mecha:v2", socketFactory: () => { queueMicrotask(() => socket.emit("open", {} as never)); return socket; } });
  try {
    const pending = client.snapshot("match-1");
    await waitForRequest(socket);
    const request = JSON.parse(socket.sent[0]);
    assert.equal(request.capability, "mecha:v2");
    const response = { protocol: "app-remote:v1", appId: "city", sessionId: "match-1", capability: "mecha:v1", type: "response", requestId: request.requestId, result: { ok: false, error: { code: "forbidden" } } };
    socket.emit("message", { data: JSON.stringify(response) } as never);
    socket.emit("message", { data: JSON.stringify({ ...response, capability: "mecha:v2", result: { ok: true, value: snapshot } }) } as never);
    assert.deepEqual(await pending, { ok: true, value: snapshot });
  } finally { client.dispose(); }
});


test("remote client never sends legacy concession, including to an old host", async () => {
  let connected = false;
  const client = new RemoteMatchClient({ url: "wss://example.test", playerId: "guest", socketFactory: () => { connected = true; return new FakeSocket(); } });
  try {
    assert.deepEqual(await client.concede("match-1"), { ok: false, error: { code: "unavailable" } });
    assert.equal(connected, false);
  } finally { client.dispose(); }
});

test("host rejects even delayed legacy concession after PvP replacement", () => {
  const originalWindow = globalThis.window;
  const replies: any[] = []; let dispatch!: (event: { detail: unknown }) => void;
  const host = { __AV_MECHA_SESSION_TOKEN__: "session-secret", __TAURI__: { core: { invoke: (_: string, args: { reply: unknown }) => { replies.push(args.reply); return Promise.resolve(); } } },
    addEventListener: (_: string, handler: typeof dispatch) => { dispatch = handler; } };
  Object.defineProperty(globalThis, "window", { value: host, configurable: true, writable: true });
  const send = (method: string, payload: unknown, requestId = method) => dispatch({ detail: { token: "session-secret", request: { protocol: MECHA_NET_PROTOCOL, type: "request", requestId, method, payload } } });
  try {
    startRemoteSessionHost();
    send("match.create", { config: { matchId: "match-1", mode: "pve", arena, state: snapshot.state, players: snapshot.players } });
    send("match.join", { matchId: "match-1", playerId: "guest" });
    assert.deepEqual(replies.at(-1), { type: "joined", token: "session-secret", ok: true });
    send("match.snapshot", { matchId: "match-1", playerId: "guest" }, "before");
    const before = structuredClone(replies.at(-1).message.result);
    assert.equal(before.value.mode, "pvp");
    send("match.concede", { matchId: "match-1", playerId: "guest" }, "delayed");
    assert.deepEqual(replies.at(-1).message.result, { ok: false, error: { code: "unavailable" } });
    send("match.snapshot", { matchId: "match-1", playerId: "guest" }, "after");
    assert.deepEqual(replies.at(-1).message.result, before);
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
  }
});

test("v3 host/client concession retries the same command after a lost response, without resolving twice", async () => {
  const originalWindow = globalThis.window;
  let listener: ((event: { detail: unknown }) => void) | undefined;
  let socket: FakeSocket | undefined;
  let dropConcedeResponse = true;
  let concedeEvents = 0;
  let lastMethod = "";
  const host = {
    __AV_MECHA_SESSION_TOKEN__: "session-secret",
    __TAURI__: { core: { invoke: (_command: string, args: { reply: any }) => {
      const reply = args.reply;
      if (reply.type === "message" && socket) {
        const message = reply.message;
        if (message.type === "event" && message.event.type === "turn.resolved") concedeEvents++;
        if (message.type === "response" && lastMethod === "match.concede-v2" && dropConcedeResponse) dropConcedeResponse = false;
        else socket.emit("message", { data: JSON.stringify({ ...message, protocol: "app-remote:v1", appId: "city", sessionId: "match-1", capability: "mecha:v3" }) } as never);
      }
      return Promise.resolve();
    } } },
    addEventListener: (_type: string, handler: (event: { detail: unknown }) => void) => { listener = handler; },
  };
  Object.defineProperty(globalThis, "window", { value: host, configurable: true, writable: true });
  const dispatch = (request: any) => listener!({ detail: { token: "session-secret", request: { ...request, protocol: MECHA_NET_PROTOCOL, type: "request" } } });
  let client: RemoteMatchClient | undefined;
  try {
    startRemoteSessionHost();
    dispatch({ requestId: "create", method: "match.create", payload: { config: { matchId: "match-1", mode: "pve", arena, state: snapshot.state, players: snapshot.players } } });
    dispatch({ requestId: "join", method: "match.join", payload: { matchId: "match-1", playerId: "guest" } });
    socket = new FakeSocket();
    socket.send = (data: string) => { socket!.sent.push(data); const request = JSON.parse(data); lastMethod = request.method; dispatch(request); };
    client = new RemoteMatchClient({ url: "wss://example.test", playerId: "guest", capability: "mecha:v3", timeoutMs: 20,
      socketFactory: () => { queueMicrotask(() => socket!.emit("open", {} as never)); return socket!; } });
    const current = await client.snapshot("match-1");
    assert.ok(current.ok && current.value.mode === "pvp");
    if (!current.ok) return;
    const command = { type: "match.concede-v2" as const, protocol: MECHA_NET_PROTOCOL, matchId: "match-1", playerId: "guest", commandId: "c1", baseRevision: current.value.revision };
    await assert.rejects(client.submitConcede(command, current.value.ruleset), /host_offline/);
    const retry = await client.submitConcede(command, current.value.ruleset);
    assert.ok(retry.ok);
    assert.equal(concedeEvents, 1);
    assert.deepEqual(JSON.parse(socket.sent.at(-1)!).payload, command);
    assert.equal(JSON.parse(socket.sent.at(-1)!).capability, "mecha:v3");
  } finally {
    client?.dispose();
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
  }
});
