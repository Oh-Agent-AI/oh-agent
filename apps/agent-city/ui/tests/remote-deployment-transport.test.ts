import assert from "node:assert/strict";
import test from "node:test";
import { RemoteMatchClient, type WebSocketLike } from "../src/game/mecha/client/RemoteMatchClient.ts";
import { MECHA_NET_PROTOCOL, type SubmitDeploymentCommand } from "../src/game/mecha/contracts/match.ts";
import { deploymentResult } from "../src/game/mecha/contracts/transport.ts";
import { remoteArenaFromSite } from "../src/game/mecha/contracts/arena.ts";
import { createMatch, MECH_IDS } from "../src/game/mecha/rules.ts";
import { startRemoteSessionHost } from "../src/remote/RemoteSessionHost.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";

const terrain = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const));
const heights = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0));
const site: CityMechaSite = { originX: 0, originZ: 0, yaw: 0, cellW: 8, cellD: 8, terrain, heights,
  buildings: [], blocked: [], mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: 3 * i, y: 9 } })),
  boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0 };
const arena = remoteArenaFromSite(site, { arenaId: "city-flat", sourceRevision: "flat-1" });
const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", deployment: true });
const command: SubmitDeploymentCommand = { type: "deployment.submit", protocol: MECHA_NET_PROTOCOL, matchId: "m1", playerId: "owner", commandId: "d1", baseRevision: 0,
  plan: { revision: 0, placements: MECH_IDS.map((mechId, i) => ({ mechId, pos: { x: i * 3, y: 8 } })) } };

// This is deliberately an in-memory bridge, not the production gateway or relay.
test("staged client and host preserve authority over lost replies, retries, and reconnect", async () => {
  const originalWindow = globalThis.window;
  let dispatch!: (event: { detail: unknown }) => void;
  let active: BridgeSocket | null = null;
  let loseDeploymentResponse = false;
  let alterResponse: ((message: any) => void) | undefined;
  const replies: any[] = [];
  class BridgeSocket implements WebSocketLike {
    listeners = new Map<string, Array<(event: never) => void>>();
    addEventListener(type: "open" | "message" | "close" | "error", listener: (event: never) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event as never); }
    send(data: string) {
      const request = JSON.parse(data);
      dispatch({ detail: { token: "session-secret", request: { ...request, protocol: MECHA_NET_PROTOCOL } } });
    }
    close() { if (active === this) active = null; this.emit("close", {}); }
  }
  const host = {
    __AV_MECHA_SESSION_TOKEN__: "session-secret",
    __TAURI__: { core: { invoke: (_name: string, args: { reply: any }) => {
      const reply = args.reply; replies.push(reply);
      if (reply.type === "message" && active) {
        if (loseDeploymentResponse && reply.message.type === "response") {
          loseDeploymentResponse = false; active.close();
        } else {
          const message = structuredClone(reply.message);
          if (message.type === "response" && alterResponse) { alterResponse(message); alterResponse = undefined; }
          active.emit("message", { data: JSON.stringify({ ...message, protocol: "app-remote:v1", appId: "city", sessionId: "m1", capability: "mecha:v2" }) });
        }
      }
      return Promise.resolve();
    } } },
    addEventListener: (_type: string, listener: typeof dispatch) => { dispatch = listener; },
  };
  Object.defineProperty(globalThis, "window", { value: host, configurable: true, writable: true });
  const client = new RemoteMatchClient({ url: "wss://example.test", playerId: "owner", capability: "mecha:v2", socketFactory: () => {
    const socket = new BridgeSocket(); active = socket; queueMicrotask(() => socket.emit("open", {})); return socket;
  } });
  const sendHost = (method: string, payload: unknown) => dispatch({ detail: { token: "session-secret", request: {
    protocol: MECHA_NET_PROTOCOL, type: "request", requestId: "host-test", method, payload,
  } } });
  try {
    startRemoteSessionHost();
    sendHost("match.create", { config: { matchId: "m1", mode: "pve", arena, state, players: [{ playerId: "owner", side: "A", role: "host" }] } });
    assert.equal(replies.at(-1).type, "created");
    const before = await client.snapshot("m1");
    assert.ok(before.ok); assert.equal((before.value.state as typeof state).phase, "deployment");
    assert.equal((before.value.state as typeof state).boss.intent, null);
    sendHost("match.join", { matchId: "m1", playerId: "guest" });
    assert.deepEqual(replies.at(-1), { type: "joined", token: "session-secret", ok: false });
    const guest = await client.submitDeployment({ ...command, playerId: "guest" });
    assert.deepEqual(guest, { ok: false, error: { code: "forbidden" } });
    const incomplete = await client.submitDeployment({ ...command, plan: { ...command.plan, placements: command.plan.placements.slice(0, 2) } });
    assert.deepEqual(incomplete, { ok: false, error: { code: "invalid_deployment", fault: { code: "incomplete" } } });
    const unchanged = await client.snapshot("m1"); assert.deepEqual(unchanged, before);
    loseDeploymentResponse = true;
    await assert.rejects(client.submitDeployment(command), /host_offline/);
    const after = await client.snapshot("m1");
    assert.ok(after.ok); assert.equal(after.value.revision, 1);
    assert.equal((after.value.state as typeof state).phase, "player_plan");
    assert.ok((after.value.state as typeof state).boss.intent);
    assert.equal(Object.hasOwn(after.value.state, "deployment"), false);
    assert.deepEqual(await client.submitDeployment(command), after);
    for (const alter of [
      (m: any) => { m.result.value.matchId = "other"; },
      (m: any) => { m.result.value.revision = 2; m.result.value.state.revision = 2; },
      (m: any) => { m.result.value.state.phase = "deployment"; },
      (m: any) => { m.result.value.status = "closed"; },
    ]) {
      alterResponse = alter;
      assert.deepEqual(await client.submitDeployment(command), { ok: false, error: { code: "invalid_message" } });
    }
    const changed = structuredClone(command); changed.plan.placements[0]!.pos.x = 1;
    assert.deepEqual(await client.submitDeployment(changed), { ok: false, error: { code: "duplicate_command" } });

    // Guest joins remain rejected after deployment and cannot replace the PvE authority.
    sendHost("match.join", { matchId: "m1", playerId: "guest" });
    assert.deepEqual(replies.at(-1), { type: "joined", token: "session-secret", ok: false });
    assert.deepEqual(await client.snapshot("m1"), after);
  } finally {
    client.dispose();
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
  }
});

test("deployment errors have bounded codes, fields, and identifiers", () => {
  const valid = { ok: false, error: { code: "invalid_deployment", fault: { code: "occupied", mechId: "Assault" } } };
  assert.deepEqual(deploymentResult(valid), valid);
  assert.deepEqual(deploymentResult({ ok: false, error: { code: "host_offline" } }), { ok: false, error: { code: "host_offline" } });
  for (const bad of [
    { ok: false, error: { code: "invalid_deployment", fault: { code: "secret" } } },
    { ok: false, error: { code: "invalid_deployment", fault: { code: "occupied", mechId: "private" } } },
    { ok: false, error: { code: "invalid_deployment", fault: { code: "occupied", extra: "private" } } },
    { ok: false, error: { code: "forbidden", fault: { code: "occupied" } } },
    { ok: false, error: { code: "not_a_code" } },
    { ok: false, error: { code: "forbidden", secret: "private" } },
  ]) assert.equal(deploymentResult(bad), null);
});


test("v1 fails closed for deployment without sending a network command", async () => {
  let sockets = 0;
  const client = new RemoteMatchClient({ url: "wss://example.test", playerId: "owner", socketFactory: () => { sockets += 1; throw new Error("unexpected_socket"); } });
  try {
    assert.deepEqual(await client.submitDeployment(command), { ok: false, error: { code: "invalid_message" } });
    assert.equal(sockets, 0);
  } finally { client.dispose(); }
});

test("guest join cannot modify a session with an exhausted revision", () => {
  const originalWindow = globalThis.window;
  let dispatch!: (event: { detail: unknown }) => void;
  const replies: any[] = [];
  const host = {
    __AV_MECHA_SESSION_TOKEN__: "session-secret",
    __TAURI__: { core: { invoke: (_name: string, args: { reply: any }) => { replies.push(args.reply); return Promise.resolve(); } } },
    addEventListener: (_type: string, listener: typeof dispatch) => { dispatch = listener; },
  };
  Object.defineProperty(globalThis, "window", { value: host, configurable: true, writable: true });
  const send = (method: string, payload: unknown) => dispatch({ detail: { token: "session-secret", request: {
    protocol: MECHA_NET_PROTOCOL, type: "request", requestId: "host-test", method, payload,
  } } });
  try {
    startRemoteSessionHost();
    const exhausted = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash" });
    exhausted.phase = "player_plan"; exhausted.revision = Number.MAX_SAFE_INTEGER - 1;
    send("match.create", { config: { matchId: "m1", mode: "pve", arena, state: exhausted, players: [{ playerId: "owner", side: "A", role: "host" }] } });
    send("match.join", { matchId: "m1", playerId: "guest" });
    assert.deepEqual(replies.at(-1), { type: "joined", token: "session-secret", ok: false });
    send("match.snapshot", { matchId: "m1", playerId: "owner" });
    assert.equal(replies.at(-1).message.result.value.mode, "pve");
    assert.equal(replies.at(-1).message.result.value.revision, exhausted.revision);
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
  }
});
