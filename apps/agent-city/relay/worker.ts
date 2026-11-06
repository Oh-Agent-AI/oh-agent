/// <reference types="@cloudflare/workers-types" />
import {
  PROTOCOL, MAX_MESSAGE_BYTES, bearer, error, failure, hostMessage, id, parseCapability, randomSecret, readObject, requestPeer, response, secretHash,
  type AccessRecord, type Peer, type RoomRecord, type TicketRecord,
} from "./protocol.ts";

type Env = { MATCH_ROOM: DurableObjectNamespace; ASSETS: Fetcher; APP_ORIGIN?: string };
const roomKey = "room:v1";
const accessKey = (id: string) => `access:${id}`;
const ticketKey = (hash: string) => `ticket:${hash}`;
const requestLifetimeMs = 30_000;

export class MatchRoom implements DurableObject {
  private readonly requests = new Map<string, { peerId: string; requestId: string; expiresAt: number }>();
  private readonly rates = new Map<string, { at: number; count: number }>();
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);
    const operation = path.at(-1);
    if (request.method === "POST" && operation === "register") return this.register(request);
    const room = await this.ctx.storage.get<RoomRecord>(roomKey);
    if (!room) return error("match_not_found", 404);
    if (request.method === "POST" && operation === "access") return this.access(request, room);
    if (request.method === "POST" && operation === "join") return this.join(request, room);
    if (request.method === "POST" && operation === "close") return this.closeRoom(request, room);
    if (operation === "ws" && request.headers.get("Upgrade") === "websocket") return this.websocket(request, room);
    return error("invalid_message", 404);
  }

  private async register(request: Request): Promise<Response> {
    const body = await readObject(request);
    const capability = parseCapability(body?.capability);
    if (!body || body.protocol !== PROTOCOL || !id(body.appId) || !id(body.sessionId) || !capability
      || typeof body.ownerToken !== "string" || body.ownerToken.length < 32 || body.ownerToken.length > 128) return error("invalid_message");
    const ownerHash = await secretHash(body.ownerToken);
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get(roomKey)) return error("room_closed", 409);
      await this.ctx.storage.put(roomKey, {
        appId: body.appId as string, sessionId: body.sessionId as string, capability, ownerHash, createdAt: Date.now(),
      } satisfies RoomRecord);
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    });
  }

  private async access(request: Request, room: RoomRecord): Promise<Response> {
    const body = await readObject(request);
    if (!body || typeof body.action !== "string") return error("invalid_message");
    const token = bearer(request);
    if (!token) return error("unauthenticated", 401);
    const hash = await secretHash(token);
    const owner = hash === room.ownerHash;
    if (body.action === "pair" && owner) {
      if (body.role !== "host" && body.role !== "owner") return error("invalid_message");
      const peer = { id: randomSecret(), role: body.role, playerId: body.role === "host" ? "host" : "owner" } as const;
      if (peer.role === "host") return this.ticket(peer);
      const reconnectToken = randomSecret();
      await this.ctx.storage.put(accessKey(peer.id), {
        id: peer.id, role: "owner", playerId: "owner", secretHash: await secretHash(reconnectToken), approved: true, expiresAt: Date.now() + 24 * 60 * 60_000,
      } satisfies AccessRecord);
      const ticket = await this.ticket(peer);
      const grant = await ticket.json() as Record<string, unknown>;
      return Response.json({ ...grant, deviceId: peer.id, reconnectToken }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "pair" && id(body.deviceId)) {
      const device = await this.ctx.storage.get<AccessRecord>(accessKey(body.deviceId));
      if (!device || device.secretHash !== hash || !device.approved || device.expiresAt <= Date.now()) return error("unauthenticated", 401);
      return this.ticket({ id: device.id, role: device.role, playerId: device.playerId });
    }
    if (!owner) return error("forbidden", 403);
    if (body.action === "invite") {
      const secret = randomSecret();
      const inviteId = randomSecret();
      await this.ctx.storage.put(accessKey(inviteId), {
        id: inviteId, role: "guest", playerId: "guest", secretHash: await secretHash(secret), approved: false, expiresAt: Date.now() + 10 * 60_000,
      } satisfies AccessRecord);
      return Response.json({ ok: true, inviteId, inviteSecret: secret, expiresIn: 600 }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "approve" && id(body.deviceId)) {
      return this.ctx.blockConcurrencyWhile(async () => {
        const device = await this.ctx.storage.get<AccessRecord>(accessKey(body.deviceId as string));
        if (!device || device.role !== "guest" || !device.joined || device.expiresAt <= Date.now()) return error("match_not_found", 404);
        const devices = await this.ctx.storage.list<AccessRecord>({ prefix: "access:" });
        if ([...devices.values()].some((other) => other.id !== device.id && other.role === "guest" && other.approved && other.expiresAt > Date.now())) return error("unavailable", 409);
        device.approved = true;
        device.expiresAt = Date.now() + 24 * 60 * 60_000;
        await this.ctx.storage.put(accessKey(device.id), device);
        return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
      });
    }
    if (body.action === "revoke" && id(body.deviceId)) {
      await this.ctx.storage.delete(accessKey(body.deviceId));
      for (const socket of this.ctx.getWebSockets()) {
        const peer = socket.deserializeAttachment() as Peer | null;
        if (peer?.id === body.deviceId) socket.close(1008, "access_revoked");
      }
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "pending") {
      const keys = await this.ctx.storage.list<AccessRecord>({ prefix: "access:" });
      const pending = [...keys.values()].filter((device) => device.role === "guest" && device.joined && !device.approved && device.expiresAt > Date.now())
        .map((device) => ({ deviceId: device.id, playerId: device.playerId }));
      return Response.json({ ok: true, pending }, { headers: { "Cache-Control": "no-store" } });
    }
    return error("invalid_message");
  }

  private async join(request: Request, room: RoomRecord): Promise<Response> {
    const body = await readObject(request);
    const secret = bearer(request);
    if (!body || body.protocol !== PROTOCOL || body.appId !== room.appId || body.sessionId !== room.sessionId || body.capability !== room.capability.id || !id(body.inviteId) || !secret
      || typeof body.deviceSecret !== "string" || !/^[0-9a-f]{64}$/.test(body.deviceSecret)) return error("invalid_message");
    const inviteHash = await secretHash(secret);
    const deviceHash = await secretHash(body.deviceSecret);
    return this.ctx.blockConcurrencyWhile(async () => {
      const key = accessKey(body.inviteId as string);
      const device = await this.ctx.storage.get<AccessRecord>(key);
      if (!device || device.role !== "guest" || device.expiresAt <= Date.now()) return error("unauthenticated", 401);
      if (device.joined) {
        if (device.inviteHash !== inviteHash || device.secretHash !== deviceHash) return error("unauthenticated", 401);
      } else {
        if (device.secretHash !== inviteHash) return error("unauthenticated", 401);
        device.inviteHash = inviteHash;
        device.secretHash = deviceHash;
        device.joined = true;
        await this.ctx.storage.put(key, device);
      }
      return Response.json({ ok: true, deviceId: device.id, approved: device.approved, playerId: "guest" }, { headers: { "Cache-Control": "no-store" } });
    });
  }

  private async closeRoom(request: Request, room: RoomRecord): Promise<Response> {
    const token = bearer(request);
    if (!token || await secretHash(token) !== room.ownerHash) return error("forbidden", 403);
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, "room_closed");
    this.requests.clear();
    this.rates.clear();
    await this.ctx.storage.deleteAll();
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }

  private async ticket(peer: Peer): Promise<Response> {
    const ticket = randomSecret();
    await this.ctx.storage.put(ticketKey(await secretHash(ticket)), { peer, expiresAt: Date.now() + 60_000 } satisfies TicketRecord);
    return Response.json({ ok: true, ticket, expiresIn: 60 }, { headers: { "Cache-Control": "no-store" } });
  }

  private async websocket(request: Request, room: RoomRecord): Promise<Response> {
    const ticket = new URL(request.url).searchParams.get("ticket");
    if (!ticket || ticket.length > 128) return error("unauthenticated", 401);
    const key = ticketKey(await secretHash(ticket));
    return this.ctx.blockConcurrencyWhile(async () => {
      const grant = await this.ctx.storage.get<TicketRecord>(key);
      await this.ctx.storage.delete(key);
      if (!grant || grant.expiresAt <= Date.now()) return error("unauthenticated", 401);
      if (grant.peer.role !== "host") {
        const device = await this.ctx.storage.get<AccessRecord>(accessKey(grant.peer.id));
        if (!device || !device.approved || device.expiresAt <= Date.now() || device.role !== grant.peer.role || device.playerId !== grant.peer.playerId) return error("unauthenticated", 401);
      }
      for (const socket of this.ctx.getWebSockets()) {
        const peer = socket.deserializeAttachment() as Peer | null;
        if (peer?.role === grant.peer.role) socket.close(1000, "connection_replaced");
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(grant.peer);
      server.send(JSON.stringify({ protocol: PROTOCOL, type: "ready", appId: room.appId, sessionId: room.sessionId, capability: room.capability.id, role: grant.peer.role, playerId: grant.peer.playerId }));
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const peer = socket.deserializeAttachment() as Peer | null;
    if (!peer || typeof message !== "string" || new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, "message_too_large");
      return;
    }
    const room = await this.ctx.storage.get<RoomRecord>(roomKey);
    if (!room) { socket.close(1000, "room_closed"); return; }
    const now = Date.now();
    // Correlation metadata stays in memory only. Expire it on activity so an
    // unresponsive host cannot permanently exhaust the bounded routing table.
    for (const [routedId, target] of this.requests) {
      if (target.expiresAt > now) continue;
      this.requests.delete(routedId);
      this.ctx.getWebSockets().find((item) => (item.deserializeAttachment() as Peer)?.id === target.peerId)
        ?.send(response(room, target.requestId, failure("unavailable")));
    }
    let value: unknown;
    let parsed = true;
    try { value = JSON.parse(message); } catch { parsed = false; }
    // A response to an admitted request must never be silently discarded by a
    // shared event budget. Only a valid, outstanding host response bypasses it.
    if (peer.role === "host" && hostMessage(value, room)) {
      const envelope = value as { type: string; requestId?: string };
      if (envelope.type === "response") {
        const target = this.requests.get(envelope.requestId!);
        if (target) {
          this.requests.delete(envelope.requestId!);
          const restored = JSON.stringify({ ...value as Record<string, unknown>, requestId: target.requestId });
          this.ctx.getWebSockets().find((item) => (item.deserializeAttachment() as Peer)?.id === target.peerId)?.send(restored);
          return;
        }
      }
    }
    const rate = this.rates.get(peer.id);
    const current = !rate || now - rate.at >= 10_000 ? { at: now, count: 0 } : rate;
    current.count += 1;
    this.rates.set(peer.id, current);
    if (current.count > 30) {
      if (peer.role === "host") {
        // Losing an event can leave clients on an old revision. Force a
        // reconnect/snapshot rather than silently dropping the event.
        this.requests.clear();
        for (const client of this.ctx.getWebSockets()) client.close(1013, "rate_limited");
      } else {
        const requestId = (value as { requestId?: unknown })?.requestId;
        socket.send(response(room, id(requestId) ? requestId : "invalid", failure("rate_limited")));
      }
      return;
    }
    if (!parsed) { socket.send(response(room, "invalid", failure("invalid_message"))); return; }
    if (peer.role === "host") {
      if (!hostMessage(value, room)) { socket.send(response(room, "invalid", failure("invalid_message"))); return; }
      const envelope = value as { type: string };
      if (envelope.type === "event") {
        for (const client of this.ctx.getWebSockets()) if ((client.deserializeAttachment() as Peer)?.role !== "host") client.send(message);
      }
      return;
    }
    const invalid = requestPeer(value, room);
    const requestId = (value as { requestId?: string })?.requestId ?? "invalid";
    if (invalid) { socket.send(response(room, requestId, failure(invalid))); return; }
    const host = this.ctx.getWebSockets().find((item) => (item.deserializeAttachment() as Peer)?.role === "host");
    if (!host) { socket.send(response(room, requestId, failure("host_offline"))); return; }
    if (this.requests.size >= 64) { socket.send(response(room, requestId, failure("rate_limited"))); return; }
    const routedId = randomSecret();
    this.requests.set(routedId, { peerId: peer.id, requestId: requestId!, expiresAt: now + requestLifetimeMs });
    host.send(JSON.stringify({ ...value as Record<string, unknown>, requestId: routedId, peer: { role: peer.role, playerId: peer.playerId } }));
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const peer = socket.deserializeAttachment() as Peer | null;
    if (!peer) return;
    this.requests.forEach((target, requestId) => { if (target.peerId === peer.id) this.requests.delete(requestId); });
    this.rates.delete(peer.id);
    if (peer.role === "host") {
      const room = await this.ctx.storage.get<RoomRecord>(roomKey);
      for (const [requestId, target] of this.requests) {
        if (room) this.ctx.getWebSockets().find((item) => (item.deserializeAttachment() as Peer)?.id === target.peerId)?.send(response(room, target.requestId, failure("host_offline")));
        this.requests.delete(requestId);
      }
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "unavailable");
  }
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const own = new URL(request.url).origin;
  return origin === own || (env.APP_ORIGIN && origin === env.APP_ORIGIN) ? origin : null;
}

function cors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const result = new Response(response.body, response);
  result.headers.set("Access-Control-Allow-Origin", origin);
  result.headers.set("Vary", "Origin");
  return result;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request, env);
    if (request.headers.has("Origin") && !origin) return error("forbidden", 403);
    if (request.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": origin ?? "", "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Allow-Methods": "POST,OPTIONS", "Cache-Control": "no-store" } });
    const url = new URL(request.url);
    if (url.pathname === "/remote" || url.pathname === "/remote/") return Response.redirect(`${url.origin}/remote.html${url.search}`, 302);
    const match = /^\/v1\/rooms\/([A-Za-z0-9:_-]{1,80})\/(register|access|join|close|ws)$/.exec(url.pathname);
    if (match) {
      const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(match[1]));
      return cors(await stub.fetch(request), origin);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
