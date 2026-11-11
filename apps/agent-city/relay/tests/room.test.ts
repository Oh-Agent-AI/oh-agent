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
  alarmAt: number | null = null;
  storage = {
    get: async (key: string) => this.values.get(key),
    put: async (key: string, value: unknown) => { this.values.set(key, structuredClone(value)); },
    delete: async (key: string) => this.values.delete(key),
    deleteAll: async () => { this.values.clear(); },
    list: async ({ prefix }: { prefix: string }) => new Map([...this.values].filter(([key]) => key.startsWith(prefix))),
    getAlarm: async () => this.alarmAt,
    setAlarm: async (time: number) => { this.alarmAt = time; },
    deleteAlarm: async () => { this.alarmAt = null; },
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>) { return callback(); }
  acceptWebSocket(socket: Socket) { this.sockets.push(socket); }
  getWebSockets() { return this.sockets.filter((socket) => !socket.closed); }
}
const ownerToken = "o".repeat(64);
const capability = { id: "mecha:v1", methods: ["match.snapshot", "plan.submit", "match.concede", "match.close"], events: ["match.closed", "match.replaced", "turn.resolved"] };
const scope = { appId: "city", sessionId: "m1", capability: capability.id };
async function room(registeredCapability = capability, roomScope = scope) {
  const state = new State();
  const object = new MatchRoom(state as never);
  const registered = await object.fetch(new Request("https://relay/v1/rooms/r1/register", { method: "POST", body: JSON.stringify({ protocol: PROTOCOL, ...roomScope, capability: registeredCapability, ownerToken }) }));
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

test("v1.5 command handoff is capability-scoped, correlated, and never persisted", async () => {
  const sequentialCapability = { id: "mecha:v4", methods: ["sequential.snapshot", "sequential.command.submit"], events: [] };
  const sequentialScope = { appId: "city", sessionId: "m-sequential", capability: sequentialCapability.id };
  const { object, state } = await room(sequentialCapability, sequentialScope);
  const owner = await connect(object, "owner");
  const host = await connect(object, "host");
  const command = { kind: "move", id: "phone-test-1", revision: 4, mech: "Assault", to: { x: 3, y: 2 } };
  const requestId = "v15-command";
  await object.webSocketMessage(owner as never, JSON.stringify({
    protocol: PROTOCOL, ...sequentialScope, type: "request", requestId, method: "sequential.command.submit",
    payload: { matchId: sequentialScope.sessionId, baseRevision: 4, command },
  }));
  const routed = JSON.parse(host.sent.at(-1)!);
  assert.equal(routed.method, "sequential.command.submit");
  assert.deepEqual(routed.peer, { role: "owner", playerId: "owner" });
  assert.notEqual(routed.requestId, requestId);
  await object.webSocketMessage(host as never, JSON.stringify({
    protocol: PROTOCOL, ...sequentialScope, type: "response", requestId: routed.requestId,
    result: { ok: false, error: { code: "stale_revision" } },
  }));
  assert.equal(JSON.parse(owner.sent.at(-1)!).requestId, requestId);
  assert.equal(JSON.stringify([...state.values.values()]).includes("phone-test-1"), false);
  await object.webSocketMessage(owner as never, JSON.stringify({
    protocol: PROTOCOL, ...sequentialScope, type: "request", requestId: "not-allowed", method: "plan.submit",
    payload: { matchId: sequentialScope.sessionId },
  }));
  assert.deepEqual(JSON.parse(owner.sent.at(-1)!).result, { ok: false, error: { code: "invalid_message" } });
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

test("dream visitors join one link, route independently and revoke separately", async () => {
  const cap = { id: "city-dream:v1", methods: ["dream.snapshot"], events: ["dream.closed"] };
  const dream = { appId: "city", sessionId: "dream-1", capability: cap.id };
  const { object, state } = await room(cap, dream);
  const host = await connect(object, "host");
  const invite = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
  const secrets = ["a".repeat(64), "b".repeat(64)];
  const ids: string[] = [];
  for (const deviceSecret of secrets) {
    const body = { protocol: PROTOCOL, ...dream, inviteId: invite.inviteId, deviceSecret };
    const join = await post(object, "join", body, invite.inviteSecret);
    assert.equal(join.status, 200);
    const { deviceId } = await join.json() as { deviceId: string };
    ids.push(deviceId);
    assert.equal((await (await post(object, "join", body, invite.inviteSecret)).json() as { deviceId: string }).deviceId, deviceId);
    assert.equal((await post(object, "access", { action: "pair", deviceId }, deviceSecret)).status, 401);
    assert.equal((await post(object, "access", { action: "approve", deviceId })).status, 200);
  }
  assert.notEqual(ids[0], ids[1]);
  const first = await connect(object, "guest", secrets[0], ids[0]);
  const second = await connect(object, "guest", secrets[1], ids[1]);
  assert.equal(first.closed, null);
  for (const socket of [first, second]) {
    await object.webSocketMessage(socket as never, JSON.stringify({ protocol: PROTOCOL, ...dream, type: "request", requestId: "same", method: "dream.snapshot", payload: {}, peer: { role: "owner", deviceId: "forged" } }));
  }
  const routed = host.sent.slice(-2).map((message) => JSON.parse(message));
  assert.deepEqual(routed.map((message) => message.peer), ids.map((deviceId) => ({ role: "guest", playerId: "guest", deviceId })));
  const [firstId, secondId] = routed.map((message) => message.requestId);
  assert.notEqual(firstId, secondId);
  await post(object, "access", { action: "revoke", deviceId: ids[0] });
  assert.equal(first.closed, 1008);
  assert.equal(second.closed, null);
  for (const [requestId, value] of [[firstId, "private-first"], [secondId, "private-second"]]) {
    await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...dream, type: "response", requestId, result: { ok: true, value } }));
  }
  assert.equal(first.sent.some((message) => message.includes("private-first")), false);
  assert.equal(JSON.parse(second.sent.at(-1)!).result.value, "private-second");
  assert.equal(JSON.stringify([...state.values.values()]).includes("private-second"), false);
  await object.webSocketMessage(second as never, JSON.stringify({ protocol: PROTOCOL, ...dream, type: "request", requestId: "wrong", method: "sequential.snapshot", payload: {} }));
  assert.equal(JSON.parse(second.sent.at(-1)!).result.error.code, "invalid_message");
});

test("dream delivery rechecks expired access before responses and events", async () => {
  const cap = { id: "city-dream:v1", methods: ["dream.snapshot"], events: ["dream.closed"] };
  const dream = { appId: "city", sessionId: "dream-expiry", capability: cap.id };
  const { object, state } = await room(cap, dream);
  const host = await connect(object, "host");
  const invite = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
  const deviceSecret = "c".repeat(64);
  const { deviceId } = await (await post(object, "join", { protocol: PROTOCOL, ...dream, inviteId: invite.inviteId, deviceSecret }, invite.inviteSecret)).json() as { deviceId: string };
  await post(object, "access", { action: "approve", deviceId });
  const visitor = await connect(object, "guest", deviceSecret, deviceId);
  await object.webSocketMessage(visitor as never, JSON.stringify({ protocol: PROTOCOL, ...dream, type: "request", requestId: "pending", method: "dream.snapshot", payload: {} }));
  const routedId = JSON.parse(host.sent.at(-1)!).requestId;
  const access = state.values.get(`access:${deviceId}`) as { expiresAt: number };
  access.expiresAt = Date.now() - 1;
  await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...dream, type: "response", requestId: routedId, result: { ok: true, value: "expired-secret" } }));
  assert.equal(visitor.sent.some((message) => message.includes("expired-secret")), false);
  await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...dream, type: "event", event: { type: "dream.closed" } }));
  assert.equal(visitor.closed, 1008);
  assert.equal(visitor.sent.some((message) => message.includes("dream.closed")), false);
});

test("dream room becomes reconnectable orphan and host reconnect renews its lease", async () => {
  const cap = { id: "city-dream:v1", methods: ["dream.snapshot"], events: ["dream.closed"] };
  const dream = { appId: "city", sessionId: "dream-orphan", capability: cap.id };
  const { object, state } = await room(cap, dream);
  const host = await connect(object, "host");
  const invite = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
  const deviceSecret = "d".repeat(64);
  const { deviceId } = await (await post(object, "join", { protocol: PROTOCOL, ...dream, inviteId: invite.inviteId, deviceSecret }, invite.inviteSecret)).json() as { deviceId: string };
  await post(object, "access", { action: "approve", deviceId });
  const visitor = await connect(object, "guest", deviceSecret, deviceId);

  host.close(1006);
  await object.webSocketClose(host as never);
  const orphan = state.values.get("room:v1") as { hostLeaseExpiresAt: number };
  assert.ok(orphan.hostLeaseExpiresAt > Date.now());
  assert.ok(state.alarmAt !== null && state.alarmAt <= orphan.hostLeaseExpiresAt);
  assert.equal(visitor.closed, 1001);
  assert.equal((await post(object, "access", { action: "invite" })).status, 200);

  await connect(object, "host");
  const reconnected = state.values.get("room:v1") as { hostLeaseExpiresAt: number };
  assert.ok(reconnected.hostLeaseExpiresAt >= orphan.hostLeaseExpiresAt);
  assert.ok(state.values.has("room:v1"));
});

test("expired orphan dream room is deleted and cannot be re-registered until cleared", async () => {
  const cap = { id: "city-dream:v1", methods: ["dream.snapshot"], events: ["dream.closed"] };
  const dream = { appId: "city", sessionId: "dream-expired", capability: cap.id };
  const { object, state } = await room(cap, dream);
  const host = await connect(object, "host");
  const invite = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
  const deviceSecret = "e".repeat(64);
  const { deviceId } = await (await post(object, "join", { protocol: PROTOCOL, ...dream, inviteId: invite.inviteId, deviceSecret }, invite.inviteSecret)).json() as { deviceId: string };
  await post(object, "access", { action: "approve", deviceId });
  const visitor = await connect(object, "guest", deviceSecret, deviceId);

  host.close(1006);
  await object.webSocketClose(host as never);
  const roomRecord = state.values.get("room:v1") as { hostLeaseExpiresAt: number };
  roomRecord.hostLeaseExpiresAt = Date.now() - 1;
  state.values.set("room:v1", roomRecord);
  await object.alarm();

  assert.equal(state.values.has("room:v1"), false);
  assert.equal(state.values.size, 0);
  assert.equal(state.alarmAt, null);
  assert.equal(visitor.closed, 1001);
  const registered = await object.fetch(new Request("https://relay/v1/rooms/r1/register", { method: "POST", body: JSON.stringify({ protocol: PROTOCOL, ...dream, capability: cap, ownerToken }) }));
  assert.equal(registered.status, 200);
});

test("delayed close from replaced dream host preserves new host requests and visitors", async () => {
  const cap = { id: "city-dream:v1", methods: ["dream.snapshot"], events: [] };
  const dream = { appId: "city", sessionId: "dream-replaced-host", capability: cap.id };
  const { object } = await room(cap, dream);
  const oldHost = await connect(object, "host");
  const owner = await connect(object, "owner");
  const newHost = await connect(object, "host");
  const invite = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
  const deviceSecret = "f".repeat(64);
  const { deviceId } = await (await post(object, "join", { protocol: PROTOCOL, ...dream, inviteId: invite.inviteId, deviceSecret }, invite.inviteSecret)).json() as { deviceId: string };
  await post(object, "access", { action: "approve", deviceId });
  const visitor = await connect(object, "guest", deviceSecret, deviceId);
  oldHost.close(1000);
  await object.webSocketMessage(owner as never, JSON.stringify({ protocol: PROTOCOL, ...dream, type: "request", requestId: "new-host-request", method: "dream.snapshot", payload: {} }));
  const routedId = JSON.parse(newHost.sent.at(-1)!).requestId;

  await object.webSocketClose(oldHost as never);
  assert.equal(visitor.closed, null);
  await object.webSocketMessage(newHost as never, JSON.stringify({ protocol: PROTOCOL, ...dream, type: "response", requestId: routedId, result: { ok: true, value: "served" } }));
  assert.equal(JSON.parse(owner.sent.at(-1)!).result.value, "served");
});

test("room lease alarm cleans a room even when host close callback never ran", async () => {
  const { object, state } = await room();
  const host = await connect(object, "host");
  host.close(1006);
  const roomRecord = state.values.get("room:v1") as { hostLeaseExpiresAt: number };
  roomRecord.hostLeaseExpiresAt = Date.now() - 1;
  state.values.set("room:v1", roomRecord);
  await object.alarm();
  assert.equal(state.values.has("room:v1"), false);
  assert.equal(state.values.size, 0);
});

test("dream host disconnect closes visitors so their local scenes can be cleared", async () => {
  const cap = { id: "city-dream:v1", methods: ["dream.snapshot"], events: [] };
  const dream = { appId: "city", sessionId: "dream-offline", capability: cap.id };
  const { object } = await room(cap, dream);
  const host = await connect(object, "host");
  const invite = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
  const secret = "d".repeat(64);
  const { deviceId } = await (await post(object, "join", { protocol: PROTOCOL, ...dream, inviteId: invite.inviteId, deviceSecret: secret }, invite.inviteSecret)).json() as { deviceId: string };
  await post(object, "access", { action: "approve", deviceId });
  const visitor = await connect(object, "guest", secret, deviceId);
  host.close();
  await object.webSocketClose(host as never);
  assert.equal(visitor.closed, 1001);
});

test("dream expiry alarm closes only expired visitors without requiring activity", async () => {
  const cap = { id: "city-dream:v1", methods: ["dream.snapshot"], events: [] };
  const dream = { appId: "city", sessionId: "dream-alarm", capability: cap.id };
  const { object, state } = await room(cap, dream);
  const invite = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
  const ids: string[] = [];
  const sockets: Socket[] = [];
  for (const secret of ["e".repeat(64), "f".repeat(64)]) {
    const { deviceId } = await (await post(object, "join", { protocol: PROTOCOL, ...dream, inviteId: invite.inviteId, deviceSecret: secret }, invite.inviteSecret)).json() as { deviceId: string };
    ids.push(deviceId);
    await post(object, "access", { action: "approve", deviceId });
    sockets.push(await connect(object, "guest", secret, deviceId));
  }
  assert.ok(state.alarmAt && state.alarmAt > Date.now(), "an invitation schedules an expiry alarm");
  const record = state.values.get(`access:${ids[0]}`) as { expiresAt: number };
  record.expiresAt = Date.now() - 1;
  state.alarmAt = null; // Cloudflare consumes the alarm before invoking the handler.
  await object.alarm();
  assert.equal(sockets[0].closed, 1008);
  assert.equal(sockets[1].closed, null);
  assert.equal(state.values.has(`access:${ids[0]}`), false);
  assert.equal((await post(object, "access", { action: "pair", deviceId: ids[0] }, "e".repeat(64))).status, 401);
  assert.ok(state.alarmAt && state.alarmAt > Date.now(), "remaining access schedules the next expiry");
  await post(object, "close", {});
  assert.equal(state.alarmAt, null, "closing the room cancels its alarm");
});

test("generic room alarm removes expired access and unused tickets", async () => {
  const { object, state } = await room();
  const invite = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
  const secret = "a".repeat(64);
  const joined = await post(object, "join", { protocol: PROTOCOL, ...scope, matchId: "m1", inviteId: invite.inviteId, deviceSecret: secret }, invite.inviteSecret);
  assert.equal(joined.status, 200, await joined.clone().text());
  const { deviceId } = await joined.json() as { deviceId: string };
  await post(object, "access", { action: "approve", deviceId });
  const guest = await connect(object, "guest", secret, deviceId);
  await post(object, "access", { action: "pair", deviceId }, secret); // Leave one one-time ticket unused.
  assert.ok(state.alarmAt && state.alarmAt > Date.now());
  for (const [key, value] of state.values) {
    if ((key.startsWith("access:") || key.startsWith("ticket:")) && typeof value === "object" && value !== null && "expiresAt" in value) {
      (value as { expiresAt: number }).expiresAt = Date.now() - 1;
    }
  }
  state.alarmAt = null; // Cloudflare consumes the alarm before invoking the handler.
  await object.alarm();
  assert.equal(guest.closed, 1008);
  assert.equal([...state.values.keys()].some((key) => key.startsWith("access:") || key.startsWith("ticket:")), false);
  assert.ok(state.alarmAt !== null && state.alarmAt > Date.now(), "the room host lease remains scheduled after access cleanup");
});

test("closing a dream wins over an invitation waiting for the room lock", async () => {
  const cap = { id: "city-dream:v1", methods: ["dream.snapshot"], events: [] };
  const dream = { appId: "city", sessionId: "dream-close-race", capability: cap.id };
  const { object, state } = await room(cap, dream);
  let release!: () => void;
  let observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { observed = resolve; });
  const normal = state.blockConcurrencyWhile.bind(state);
  let first = true;
  state.blockConcurrencyWhile = async <T>(callback: () => Promise<T>) => {
    if (first) { first = false; observed(); await gate; }
    return normal(callback);
  };
  const invitation = post(object, "access", { action: "invite" });
  await waiting;
  assert.equal((await post(object, "close", {})).status, 200);
  release();
  assert.equal((await invitation).status, 409);
  assert.equal(state.values.size, 0);
  assert.equal(state.alarmAt, null);
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


test("prepared deployment capability stays versioned, correlated and peer-bound at the relay", async () => {
  const old = await room();
  const oldOwner = await connect(old.object, "owner");
  const oldHost = await connect(old.object, "host");
  const deployment = { protocol: PROTOCOL, ...scope, type: "request", requestId: "deploy-1", method: "deployment.submit", payload: { matchId: "m1", playerId: "owner", commandId: "d1" } };
  await old.object.webSocketMessage(oldOwner as never, JSON.stringify(deployment));
  assert.equal(JSON.parse(oldOwner.sent.at(-1)!).result.error.code, "invalid_message");
  assert.equal(oldHost.sent.length, 1, "v1 must not forward a deployment method");

  // This registers a synthetic v2 room only; it does not change the live City capability.
  const v2 = { ...capability, id: "mecha:v2", methods: [...capability.methods, "deployment.submit"] };
  const v2scope = { ...scope, capability: v2.id };
  const { object, state } = await room(v2);
  const owner = await connect(object, "owner");
  const host = await connect(object, "host");
  await object.webSocketMessage(owner as never, JSON.stringify({ ...deployment, ...v2scope, peer: { role: "guest", playerId: "guest" } }));
  const routed = JSON.parse(host.sent.at(-1)!);
  assert.deepEqual(routed.peer, { role: "owner", playerId: "owner" });
  assert.notEqual(routed.requestId, deployment.requestId);
  await object.webSocketMessage(host as never, JSON.stringify({ protocol: PROTOCOL, ...v2scope, type: "response", requestId: routed.requestId, result: { ok: true } }));
  assert.equal(JSON.parse(owner.sent.at(-1)!).requestId, deployment.requestId);

  const invite = await (await post(object, "access", { action: "invite" })).json() as { inviteId: string; inviteSecret: string };
  const deviceSecret = "a".repeat(64);
  const joined = await (await post(object, "join", { protocol: PROTOCOL, ...v2scope, matchId: "m1", inviteId: invite.inviteId, deviceSecret }, invite.inviteSecret)).json() as { deviceId: string };
  assert.equal((await post(object, "access", { action: "approve", deviceId: joined.deviceId })).status, 200);
  const guest = await connect(object, "guest", deviceSecret, joined.deviceId);
  await object.webSocketMessage(guest as never, JSON.stringify({ ...deployment, ...v2scope, peer: { role: "owner", playerId: "owner" } }));
  const forged = JSON.parse(host.sent.at(-1)!);
  assert.deepEqual(forged.peer, { role: "guest", playerId: "guest" }, "gateway must reject this guest despite its forged owner payload");
  assert.equal(forged.payload.playerId, "owner", "the relay is a generic router, not the match authority");
  assert.equal(JSON.stringify([...state.values.values()]).includes('"commandId":"d1"'), false, "match command bodies must not be persisted");
});
