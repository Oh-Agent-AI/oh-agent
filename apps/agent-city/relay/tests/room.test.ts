import assert from "node:assert/strict";
import test from "node:test";
import { MatchRoom } from "../worker.ts";
import { PROTOCOL } from "../protocol.ts";

class Socket {
  sent: string[] = [];
  closed: number | null = null;
  attachment: unknown = null;
  peer: Socket | null = null;
  accept() {}
  send(value: string) { this.sent.push(value); }
  close(code = 1000) { this.closed = code; }
  serializeAttachment(value: unknown) { this.attachment = value; }
  deserializeAttachment() { return this.attachment; }
}
class Pair {
  0 = new Socket();
  1 = new Socket();
  constructor() { this[0].peer = this[1]; this[1].peer = this[0]; }
}
const NativeResponse = Response;
class TestResponse extends NativeResponse {
  constructor(body: BodyInit | null | undefined, init: ResponseInit | undefined) {
    super(body, { ...init, status: init?.status === 101 ? 200 : init?.status });
    if (init?.status === 101) {
      Object.defineProperty(this, "status", { value: 101 });
      Object.assign(this, { webSocket: (init as ResponseInit & { webSocket: Socket }).webSocket });
    }
  }
}
Object.assign(globalThis, { WebSocketPair: Pair, Response: TestResponse });
class State {
  values = new Map<string, unknown>();
  sockets: Socket[] = [];
  storage = {
    get: async (key: string) => this.values.get(key),
    put: async (key: string, value: unknown) => { this.values.set(key, structuredClone(value)); },
    delete: async (key: string) => this.values.delete(key),
    deleteAll: async () => { this.values.clear(); },
    list: async ({ prefix }: { prefix: string }) => new Map([...this.values].filter(([key]) => key.startsWith(prefix))),
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>) { return callback(); }
  acceptWebSocket(socket: Socket) { this.sockets.push(socket); }
  getWebSockets() { return this.sockets.filter((socket) => !socket.closed); }
}
const ownerToken = "o".repeat(64);
const capability = { id: "mecha:v1", methods: ["match.snapshot", "plan.submit", "match.concede", "match.close"], events: ["match.closed", "match.replaced", "turn.resolved"] };
const scope = { appId: "city", sessionId: "m1", capability: capability.id };
async function room() {
  const state = new State();
  const object = new MatchRoom(state as never);
  const registered = await object.fetch(new Request("https://relay/v1/rooms/r1/register", { method: "POST", body: JSON.stringify({ protocol: PROTOCOL, ...scope, capability, ownerToken }) }));
  assert.equal(registered.status, 200);
  return { state, object };
}
async function post(object: MatchRoom, operation: string, body: unknown, token = ownerToken) {
  return object.fetch(new Request(`https://relay/v1/rooms/r1/${operation}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
}
async function connect(object: MatchRoom, role: string, token = ownerToken, deviceId?: string) {
  const access = await post(object, "access", { action: "pair", role, deviceId }, token);
  assert.equal(access.status, 200);
  const { ticket } = await access.json() as { ticket: string };
  const response = await object.fetch(new Request(`https://relay/v1/rooms/r1/ws?ticket=${ticket}`, { headers: { Upgrade: "websocket" } }));
  assert.equal(response.status, 101);
  const server = (response as unknown as { webSocket: Socket }).webSocket;
  return server.peer!;
}
function request(requestId = "r1") {
  return JSON.stringify({ protocol: PROTOCOL, ...scope, type: "request", requestId, method: "match.snapshot", payload: { matchId: "m1", playerId: "owner" } });
}

test("one-time tickets connect owner and host; socket identity overrides claims", async () => {
  const { object } = await room();
  const owner = await connect(object, "owner");
  const host = await connect(object, "host");
  assert.equal(JSON.parse(owner.sent[0]).type, "ready");
  const access = await post(object, "access", { action: "pair", role: "owner" });
  const grant = await access.json() as { deviceId: string; reconnectToken: string };
  assert.ok(grant.deviceId && grant.reconnectToken);
  const renewed = await post(object, "access", { action: "pair", deviceId: grant.deviceId }, grant.reconnectToken);
  assert.equal(renewed.status, 200);
  assert.ok((await renewed.json() as { ticket: string }).ticket);
  assert.equal((await post(object, "access", { action: "revoke", deviceId: grant.deviceId })).status, 200);
  assert.equal((await post(object, "access", { action: "pair", deviceId: grant.deviceId }, grant.reconnectToken)).status, 401);
  await object.webSocketMessage(owner as never, request());
  assert.equal(host.sent.length, 2);
  const forged = { ...JSON.parse(request()), peer: { role: "guest", playerId: "guest" }, payload: { matchId: "m1", playerId: "guest" } };
  await object.webSocketMessage(owner as never, JSON.stringify(forged));
  assert.equal(host.sent.length, 3);
  assert.deepEqual(JSON.parse(host.sent.at(-1)!).peer, { role: "owner", playerId: "owner" });
  const ticket = JSON.parse((await (await post(object, "access", { action: "pair", role: "host" })).text())).ticket;
  await object.fetch(new Request(`https://relay/v1/rooms/r1/ws?ticket=${ticket}`, { headers: { Upgrade: "websocket" } }));
  assert.equal((await object.fetch(new Request(`https://relay/v1/rooms/r1/ws?ticket=${ticket}`, { headers: { Upgrade: "websocket" } }))).status, 401);
});

test("host responses are correlated and events broadcast to clients", async () => {
  const { object } = await room();
  const owner = await connect(object, "owner");
  const host = await connect(object, "host");
  await object.webSocketMessage(owner as never, request("correlated"));
  const routedId = JSON.parse(host.sent.at(-1)!).requestId;
  await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...scope, type: "response", requestId: routedId, result: { ok: false, error: { code: "unavailable" } } }));
  assert.equal(JSON.parse(owner.sent.at(-1)!).requestId, "correlated");
  await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...scope, type: "event", event: { type: "match.closed", matchId: "m1", revision: 1 } }));
  assert.equal(JSON.parse(owner.sent.at(-1)!).type, "event");
});

test("identical client request ids are routed independently", async () => {
  const { object } = await room();
  const owner = await connect(object, "owner");
  const host = await connect(object, "host");
  const invitation = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
  const deviceSecret = "a".repeat(64);
  const device = await (await post(object, "join", { protocol: PROTOCOL, ...scope, matchId: "m1", inviteId: invitation.inviteId, deviceSecret }, invitation.inviteSecret)).json() as { deviceId: string };
  await post(object, "access", { action: "approve", deviceId: device.deviceId });
  const guest = await connect(object, "guest", deviceSecret, device.deviceId);
  await object.webSocketMessage(owner as never, request("same-id"));
  const ownerRouted = JSON.parse(host.sent.at(-1)!).requestId;
  await object.webSocketMessage(guest as never, request("same-id").replace("owner", "guest"));
  const guestRouted = JSON.parse(host.sent.at(-1)!).requestId;
  assert.notEqual(ownerRouted, guestRouted);
  await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...scope, type: "response", requestId: guestRouted, result: { ok: true, value: { for: "guest" } } }));
  await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...scope, type: "response", requestId: ownerRouted, result: { ok: true, value: { for: "owner" } } }));
  assert.equal(JSON.parse(owner.sent.at(-1)!).result.value.for, "owner");
  assert.equal(JSON.parse(guest.sent.at(-1)!).result.value.for, "guest");
  assert.equal(JSON.parse(owner.sent.at(-1)!).requestId, "same-id");
  assert.equal(JSON.parse(guest.sent.at(-1)!).requestId, "same-id");
});

test("a second guest cannot take over an approved guest seat", async () => {
  const { object } = await room();
  const joined: string[] = [];
  for (const secret of ["a".repeat(64), "b".repeat(64)]) {
    const invite = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
    const response = await post(object, "join", { protocol: PROTOCOL, ...scope, matchId: "m1", inviteId: invite.inviteId, deviceSecret: secret }, invite.inviteSecret);
    joined.push((await response.json() as { deviceId: string }).deviceId);
  }
  assert.equal((await post(object, "access", { action: "approve", deviceId: joined[0] })).status, 200);
  assert.equal((await post(object, "access", { action: "approve", deviceId: joined[0] })).status, 200);
  assert.equal((await post(object, "access", { action: "approve", deviceId: joined[1] })).status, 409);
  assert.equal((await post(object, "access", { action: "pair", deviceId: joined[1] }, "b".repeat(64))).status, 401);
});

test("synthetic island uses the same room router without crossing scopes", async () => {
  const object = new MatchRoom(new State() as never);
  const island = { appId: "island", sessionId: "s2", capability: "island:v1" };
  const descriptor = { id: island.capability, methods: ["island.visit"], events: ["island.changed"] };
  const registration = await object.fetch(new Request("https://relay/v1/rooms/r1/register", { method: "POST", body: JSON.stringify({ protocol: PROTOCOL, ...island, capability: descriptor, ownerToken }) }));
  assert.equal(registration.status, 200);
  const owner = await connect(object, "owner");
  const host = await connect(object, "host");
  const request = { protocol: PROTOCOL, ...island, type: "request", requestId: "r1", method: "island.visit", payload: {} };
  for (const wrong of [{ appId: "city" }, { sessionId: "m1" }, { capability: "mecha:v1" }, { method: "plugin_request" }]) {
    await object.webSocketMessage(owner as never, JSON.stringify({ ...request, ...wrong }));
    assert.equal(host.sent.length, 1);
  }
  await object.webSocketMessage(owner as never, JSON.stringify(request));
  const routed = JSON.parse(host.sent.at(-1)!);
  assert.deepEqual(routed.peer, { role: "owner", playerId: "owner" });
  await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...island, type: "response", requestId: routed.requestId, result: { ok: true } }));
  assert.equal(JSON.parse(owner.sent.at(-1)!).requestId, "r1");
  const count = owner.sent.length;
  await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...island, type: "event", event: { type: "match.closed" } }));
  assert.equal(owner.sent.length, count);
  await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...island, type: "event", event: { type: "island.changed" } }));
  assert.equal(JSON.parse(owner.sent.at(-1)!).event.type, "island.changed");
});

test("friend invitation is claimed by one device and revocation invalidates issued tickets", async () => {
  const { object } = await room();
  const invitation = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
  const pending = await (await post(object, "access", { action: "pending" })).json() as { pending: unknown[] };
  assert.equal(pending.pending.length, 0);
  assert.equal((await post(object, "access", { action: "approve", deviceId: invitation.inviteId })).status, 404);
  const deviceSecret = "a".repeat(64);
  const body = { protocol: PROTOCOL, ...scope, matchId: "m1", inviteId: invitation.inviteId, deviceSecret };
  const join = await post(object, "join", body, invitation.inviteSecret);
  const device = await join.json() as { deviceId: string };
  assert.equal(join.status, 200);
  assert.equal((await post(object, "join", body, invitation.inviteSecret)).status, 200);
  assert.equal((await post(object, "join", { ...body, deviceSecret: "b".repeat(64) }, invitation.inviteSecret)).status, 401);
  assert.equal((await post(object, "join", body, "f".repeat(64))).status, 401);
  assert.equal((await post(object, "access", { action: "pair", deviceId: device.deviceId }, invitation.inviteSecret)).status, 401);
  assert.equal((await post(object, "access", { action: "pair", deviceId: device.deviceId }, deviceSecret)).status, 401);
  assert.equal((await post(object, "access", { action: "approve", deviceId: device.deviceId })).status, 200);
  const guest = await connect(object, "guest", deviceSecret, device.deviceId);
  assert.equal(JSON.parse(guest.sent[0]).playerId, "guest");
  await object.webSocketMessage(guest as never, request().replace("owner", "guest"));
  assert.equal(JSON.parse(guest.sent.at(-1)!).result.error.code, "host_offline");
  const ticket = await (await post(object, "access", { action: "pair", deviceId: device.deviceId }, deviceSecret)).json() as { ticket: string };
  assert.equal((await post(object, "access", { action: "revoke", deviceId: device.deviceId })).status, 200);
  assert.equal(guest.closed, 1008);
  const afterRevoke = await object.fetch(new Request(`https://relay/v1/rooms/r1/ws?ticket=${ticket.ticket}`, { headers: { Upgrade: "websocket" } }));
  assert.equal(afterRevoke.status, 401);
});

test("host events cannot consume the rate budget for correlated responses", async () => {
  const { object } = await room();
  const owner = await connect(object, "owner");
  const host = await connect(object, "host");
  for (let i = 0; i < 16; i++) {
    await object.webSocketMessage(owner as never, request(`request-${i}`));
    const routedId = JSON.parse(host.sent.at(-1)!).requestId;
    await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...scope, type: "event", event: { type: "turn.resolved" } }));
    await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...scope, type: "response", requestId: routedId, result: { ok: true } }));
  }
  const replies = owner.sent.map((message) => JSON.parse(message)).filter((message) => message.type === "response");
  assert.deepEqual(replies.map((reply) => reply.requestId), Array.from({ length: 16 }, (_, i) => `request-${i}`));
  assert.ok(replies.every((reply) => reply.result.ok));
});

test("rate limited client requests receive an error for their own request id", async () => {
  const { object } = await room();
  const owner = await connect(object, "owner");
  await connect(object, "host");
  for (let i = 0; i < 31; i++) await object.webSocketMessage(owner as never, request(`request-${i}`));
  const reply = JSON.parse(owner.sent.at(-1)!);
  assert.equal(reply.requestId, "request-30");
  assert.equal(reply.result.error.code, "rate_limited");
});

test("expired routing entries are released and late responses are not misdelivered", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const { object } = await room();
    const owner = await connect(object, "owner");
    const host = await connect(object, "host");
    for (let i = 0; i < 64; i++) {
      if (i === 30 || i === 60) now += 10_000;
      await object.webSocketMessage(owner as never, request(`request-${i}`));
    }
    const firstRoutedId = JSON.parse(host.sent[1]!).requestId;
    assert.equal(host.sent.length, 65);
    now += 10_001;
    await object.webSocketMessage(owner as never, request("new-request"));
    assert.equal(host.sent.length, 66);
    assert.equal(JSON.parse(host.sent.at(-1)!).method, "match.snapshot");
    assert.ok(owner.sent.some((message) => {
      const reply = JSON.parse(message);
      return reply.requestId === "request-0" && reply.result?.error?.code === "unavailable";
    }));
    const count = owner.sent.length;
    await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...scope, type: "response", requestId: firstRoutedId, result: { ok: true } }));
    assert.equal(owner.sent.length, count);
  } finally { Date.now = originalNow; }
});

test("host event floods disconnect peers instead of silently dropping events", async () => {
  const { object } = await room();
  const owner = await connect(object, "owner");
  const host = await connect(object, "host");
  for (let i = 0; i < 31; i++) {
    await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...scope, type: "event", event: { type: "turn.resolved" } }));
  }
  assert.notEqual(host.closed, null);
  assert.notEqual(owner.closed, null);
});

test("malformed host messages still count against the event budget", async () => {
  const { object } = await room();
  const owner = await connect(object, "owner");
  const host = await connect(object, "host");
  for (let i = 0; i < 31; i++) await object.webSocketMessage(host as never, "{");
  assert.notEqual(host.closed, null);
  assert.notEqual(owner.closed, null);
});
