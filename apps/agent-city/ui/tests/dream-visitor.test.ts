import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DreamSnapshotChannel, DreamVisitorAccess } from "../src/remote/city/dreamVisitor.ts";
import { encodeDreamSnapshot } from "../src/remote/city/dreamSnapshotCodec.ts";
import { parseDreamCitySnapshot } from "../src/remote/city/dreamSnapshotContract.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
class Socket extends EventTarget {
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
const room = { origin: "https://relay.example", roomId: "room1", sessionId: "publication1", inviteId: "invite1" };
const scope = { protocol: "app-remote:v1", appId: "city", sessionId: room.sessionId, capability: "city-dream:v1" };

test("each visitor joins with independent credentials and pairs only after approval", async () => {
  const joins: Array<{ url: string; auth: string; secret: string }> = [];
  let approved = false;
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    const auth = (init?.headers as Record<string, string>).Authorization;
    if (url.endsWith("/join")) {
      joins.push({ url, auth, secret: body.deviceSecret });
      return Response.json({ ok: true, deviceId: `device${joins.length}`, playerId: "guest" });
    }
    if (!approved) return Response.json({ ok: false }, { status: 401 });
    return Response.json({ ok: true, ticket: "a".repeat(64) });
  };
  const first = new DreamVisitorAccess(room, new MemoryStorage(), request);
  const second = new DreamVisitorAccess(room, new MemoryStorage(), request);
  await first.join("b".repeat(64)); await second.join("b".repeat(64));
  assert.notEqual(joins[0].secret, joins[1].secret);
  assert.equal(joins[0].auth, `Bearer ${"b".repeat(64)}`);
  assert.equal(joins[0].url.includes("b".repeat(64)), false);
  assert.equal(await first.ticket(), null);
  approved = true;
  const url = await first.ticket();
  assert.equal(url?.protocol, "wss:");
  assert.equal(url?.pathname, "/v1/rooms/room1/ws");
  assert.equal(url?.searchParams.get("ticket"), "a".repeat(64));
  await first.join("b".repeat(64));
  assert.equal(joins.length, 2, "already joined device reuses its stored grant");
  first.forget();
  await assert.rejects(first.ticket(), /dream_not_joined/);
});

test("snapshot requests require scoped ready and deliver only their correlated response", async () => {
  const socket = new Socket();
  let invalidations = 0;
  const channel = new DreamSnapshotChannel(socket as unknown as WebSocket, room.sessionId, () => { invalidations++; });
  await assert.rejects(channel.snapshot(), /dream_disconnected/);
  socket.message({ ...scope, type: "ready", role: "guest", playerId: "guest" });
  const result = channel.snapshot();
  const sent = JSON.parse(socket.sent[0]);
  assert.equal(sent.method, "dream.snapshot");
  const bytes = new TextEncoder().encode("city snapshot");
  const snapshot = await encodeDreamSnapshot(bytes);
  socket.message({ ...scope, type: "response", requestId: "other", result: { ok: true, snapshot } });
  socket.message({ ...scope, type: "response", requestId: sent.requestId, result: { ok: true, snapshot } });
  assert.deepEqual(await result, bytes);
  channel.close(); channel.close();
  assert.equal(invalidations, 1);
});

test("wrong scope or revoked connection cannot deliver a snapshot", async () => {
  const socket = new Socket();
  const channel = new DreamSnapshotChannel(socket as unknown as WebSocket, room.sessionId, () => {});
  socket.message({ ...scope, type: "ready", role: "guest", playerId: "guest" });
  const pending = channel.snapshot();
  const snapshot = await encodeDreamSnapshot(new TextEncoder().encode("sensitive"));
  socket.message({ ...scope, sessionId: "other", type: "response", requestId: "snapshot-1", result: { ok: true, snapshot } });
  await assert.rejects(pending, /dream_disconnected/);
  assert.equal(channel.isReady(), false);
});

test("revocation during decompression suppresses the decoded snapshot", async () => {
  const socket = new Socket();
  let invalidations = 0;
  const channel = new DreamSnapshotChannel(socket as unknown as WebSocket, room.sessionId, () => { invalidations++; });
  socket.message({ ...scope, type: "ready", role: "guest", playerId: "guest" });
  const pending = channel.snapshot();
  const snapshot = await encodeDreamSnapshot(new Uint8Array(512 * 1024).fill(65));
  socket.message({ ...scope, type: "response", requestId: "snapshot-1", result: { ok: true, snapshot } });
  socket.close();
  await assert.rejects(pending, /dream_disconnected/);
  assert.equal(invalidations, 1);
});

test("remote origin and link identifiers are constrained", () => {
  assert.throws(() => new DreamVisitorAccess({ ...room, origin: "http://relay.example" }, new MemoryStorage()), /dream_link_invalid/);
  assert.throws(() => new DreamVisitorAccess({ ...room, roomId: "../other" }, new MemoryStorage()), /dream_link_invalid/);
  assert.throws(() => new DreamVisitorAccess({ ...room, origin: "https://user:pass@relay.example" }, new MemoryStorage()), /dream_link_invalid/);
});

test("visitor rejects unsupported versions and dangling visual references", () => {
  const city = JSON.parse(readFileSync(new URL("../../../desktop/src-tauri/tests/fixtures/dream-city-visual-synthetic.json", import.meta.url), "utf8"));
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  assert.equal(parseDreamCitySnapshot(encode(city)).revision, 1);
  for (const invalid of [
    { ...city, schema: "dream-city-snapshot:v1" },
    { ...city, heroBuildingId: "building-9999" },
    { ...city, palettes: [{ ...city.palettes[0], districtId: "district-9999" }] },
    { ...city, palettes: [{ ...city.palettes[0], flagShare: 2 }] },
    { ...city, extra: "unknown" },
  ]) assert.throws(() => parseDreamCitySnapshot(encode(invalid)), /dream_snapshot_invalid/);
});
