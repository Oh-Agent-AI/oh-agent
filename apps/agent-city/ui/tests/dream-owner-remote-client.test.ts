import { test } from "node:test";
import assert from "node:assert/strict";
import { DreamOwnerRemoteClient } from "../src/remote/city/DreamOwnerRemoteClient.ts";

const envelope = { schema: "dream-city-gzip:v1", plainBytes: 64, data: "eA==" } as const;
const sessionId = "dream-session-01";
const inviteUrl = `https://relay.example/remote?room=room-01&publication=${sessionId}&invite=invite-01&capability=city-dream%3Av1#${"a".repeat(64)}`;

test("Dream publication requires explicit consent before any host request", async () => {
  const calls: unknown[] = [];
  const client = new DreamOwnerRemoteClient(async (...args) => { calls.push(args); return {}; });
  await assert.rejects(client.start({ relay: "https://relay.example", envelope, confirmed: false as never }), /dream_publication_confirmation_required/);
  await assert.rejects(client.start({ relay: "https://relay.example/path", envelope, confirmed: true }), /dream_publication_confirmation_required/);
  assert.deepEqual(calls, []);
});

test("start sends one trusted Dream projection and returns only the inviter link", async () => {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const client = new DreamOwnerRemoteClient(async (method, payload) => {
    calls.push({ method, payload });
    if (method === "remote.session.start") return { ok: true, sessionId, remoteUrl: "https://relay.example/remote", connection: "connecting" };
    if (method === "remote.session.invite") return { ok: true, inviteUrl, expiresIn: 600 };
    return {};
  });
  const result = await client.start({ relay: "https://relay.example/", envelope, confirmed: true });
  assert.deepEqual(result, { sessionId, inviteUrl, expiresIn: 600 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "remote.session.start");
  assert.deepEqual(calls[0].payload, { capabilityId: "city-dream:v1", relay: "https://relay.example",
    bootstrap: { projections: [{ id: "city-dream:v1", value: envelope }] } });
  assert.deepEqual(calls[1], { method: "remote.session.invite", payload: { capabilityId: "city-dream:v1", sessionId } });
});

test("failed invitation rolls back the already created session", async () => {
  const calls: string[] = [];
  const client = new DreamOwnerRemoteClient(async method => {
    calls.push(method);
    if (method === "remote.session.start") return { ok: true, sessionId, remoteUrl: "https://relay.example/remote", connection: "connecting" };
    if (method === "remote.session.invite") throw new Error("relay_unavailable");
    return { ok: true };
  });
  await assert.rejects(client.start({ relay: "https://relay.example", envelope, confirmed: true }), /relay_unavailable/);
  assert.deepEqual(calls, ["remote.session.start", "remote.session.invite", "remote.session.stop"]);
});

test("invitation links cannot redirect the relay authorization secret to another origin", async () => {
  const calls: string[] = [];
  const client = new DreamOwnerRemoteClient(async method => {
    calls.push(method);
    if (method === "remote.session.start") return { ok: true, sessionId, remoteUrl: "https://relay.example/remote", connection: "connecting" };
    if (method === "remote.session.invite") return { ok: true, inviteUrl: inviteUrl.replace("relay.example", "attacker.example"), expiresIn: 600 };
    return { ok: true };
  });
  await assert.rejects(client.start({ relay: "https://relay.example", envelope, confirmed: true }), /remote_response_invalid/);
  assert.deepEqual(calls, ["remote.session.start", "remote.session.invite", "remote.session.stop"]);
});

test("visitor approval, revocation, pending list and stop use the generic scoped API", async () => {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const client = new DreamOwnerRemoteClient(async (method, payload) => {
    calls.push({ method, payload });
    if (method === "remote.session.pending") return { ok: true, pending: [{ deviceId: "visitor-01", playerId: "guest" }] };
    return { ok: true };
  });
  assert.deepEqual(await client.pending(sessionId), [{ deviceId: "visitor-01", playerId: "guest" }]);
  await client.approve(sessionId, "visitor-01");
  await client.revoke(sessionId, "visitor-01");
  await client.stop(sessionId);
  assert.deepEqual(calls, [
    { method: "remote.session.pending", payload: { capabilityId: "city-dream:v1", sessionId } },
    { method: "remote.session.approve", payload: { capabilityId: "city-dream:v1", sessionId, deviceId: "visitor-01" } },
    { method: "remote.session.revoke", payload: { capabilityId: "city-dream:v1", sessionId, deviceId: "visitor-01" } },
    { method: "remote.session.stop", payload: { capabilityId: "city-dream:v1", sessionId } },
  ]);
});

test("owner client rejects malformed session, relay, invitation URL and visitor DTOs", async () => {
  const client = new DreamOwnerRemoteClient(async method => {
    if (method === "remote.session.start") return { ok: true, sessionId: "../private", remoteUrl: "https://city.example", connection: "connecting" };
    if (method === "remote.session.invite") return { ok: true, inviteUrl: "https://city.example/remote?room=x", expiresIn: 600 };
    if (method === "remote.session.pending") return { ok: true, pending: [{ deviceId: "guest", playerId: "owner" }] };
    return { ok: true };
  });
  await assert.rejects(client.start({ relay: "https://relay.example/path", envelope, confirmed: true }), /dream_publication_confirmation_required/);
  await assert.rejects(client.start({ relay: "https://relay.example", envelope, confirmed: true }), /remote_response_invalid/);
  await assert.rejects(client.invite(sessionId), /remote_response_invalid/);
  await assert.rejects(client.pending(sessionId), /remote_response_invalid/);
  await assert.rejects(client.approve(sessionId, "../private"), /remote_response_invalid/);
});
