import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SequentialMatchSession } from "../src/game/mecha/session/SequentialMatchSession.ts";
import { SequentialRemoteHost } from "../src/game/mecha/session/SequentialRemoteHost.ts";
import { RemoteMatchClient, type WebSocketLike } from "../src/game/mecha/client/RemoteMatchClient.ts";

function fixture() {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(state); return state;
}

class Loopback implements WebSocketLike {
  private listeners = new Map<string, Array<(event: never) => void>>();
  private readonly host: SequentialRemoteHost;
  private readonly matchId: string;
  constructor(host: SequentialRemoteHost, matchId: string) { this.host = host; this.matchId = matchId; queueMicrotask(() => this.emit("open", {})); }
  private emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event as never); }
  addEventListener(type: string, listener: (event: never) => void) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
  close() { this.emit("close", {}); }
  send(raw: string) {
    const envelope = JSON.parse(raw);
    const response = this.host.handle({ protocol: "mecha-net:v2", type: "request", requestId: envelope.requestId, method: envelope.method, payload: envelope.payload });
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ ...response, protocol: "app-remote:v1", appId: "city", sessionId: this.matchId, capability: "mecha:v1" }) }));
  }
}

test("remote client negotiates v2 snapshots and commands over the existing socket", async () => {
  const initial = fixture();
  const session = new SequentialMatchSession("match-r", initial, []);
  const host = new SequentialRemoteHost(session);
  const client = new RemoteMatchClient({ url: "ws://loopback", playerId: "p1", socketFactory: () => new Loopback(host, "match-r") });
  const snapshot = await client.sequentialSnapshot("match-r");
  assert.ok(snapshot.ok);
  if (!snapshot.ok) return;
  const command = { kind: "move" as const, id: "m", revision: snapshot.snapshot.revision, mech: "Assault" as const, to: { x: 3, y: 2 } };
  const submitted = await client.submitSequentialCommand("match-r", command.revision, command);
  assert.ok(submitted.ok);
  if (!submitted.ok) return;
  assert.equal(submitted.snapshot.commands.length, 1);
  const stale = await client.submitSequentialCommand("match-r", command.revision, { ...command, id: "m2" });
  assert.equal(stale.ok, false);
  client.dispose();
});
