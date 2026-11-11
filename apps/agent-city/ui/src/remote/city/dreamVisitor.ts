import { decodeDreamSnapshot } from "./dreamSnapshotCodec";
import { REMOTE_PROTOCOL } from "../remoteEnvelope";
import { RemoteRequestChannel } from "../RemoteRequestChannel";

const PROTOCOL = REMOTE_PROTOCOL;
const CAPABILITY = "city-dream:v1";
const SECRET = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const MAX_FRAME = 256 * 1024;
type Credentials = { deviceId: string; secret: string };
type Room = { origin: string; roomId: string; sessionId: string; inviteId: string };

function roomUrl(room: Room, operation: string): URL {
  if (![room.roomId, room.sessionId, room.inviteId].every(value => ID.test(value))) throw new Error("dream_link_invalid");
  const origin = new URL(room.origin);
  if (origin.origin !== room.origin || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) throw new Error("dream_link_invalid");
  return new URL(`/v1/rooms/${room.roomId}/${operation}`, origin);
}

function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** One browser tab holds its own credentials; no city snapshot is stored here. */
export class DreamVisitorAccess {
  private readonly room: Room;
  private readonly storage: Storage;
  private readonly request: typeof fetch;
  private readonly key: string;

  constructor(room: Room, storage: Storage, request: typeof fetch = fetch) {
    roomUrl(room, "join");
    this.room = room;
    this.storage = storage;
    // Native browser fetch requires Window as its receiver; calling an unbound
    // function as a class member otherwise throws "Illegal invocation".
    this.request = request.bind(globalThis);
    this.key = `dream-visitor:v1:${room.origin}:${room.roomId}:${room.sessionId}:${room.inviteId}`;
  }

  private read(): Credentials | null {
    try {
      const value = JSON.parse(this.storage.getItem(this.key) ?? "null") as Credentials | null;
      return value && ID.test(value.deviceId) && SECRET.test(value.secret) ? value : null;
    } catch { return null; }
  }

  async join(inviteSecret: string): Promise<void> {
    if (this.read()) return;
    if (!SECRET.test(inviteSecret)) throw new Error("dream_link_invalid");
    const pendingKey = `${this.key}:pending`;
    let secret = this.storage.getItem(pendingKey);
    if (!secret || !SECRET.test(secret)) { secret = randomSecret(); this.storage.setItem(pendingKey, secret); }
    const response = await this.request(roomUrl(this.room, "join"), {
      method: "POST", redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${inviteSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: PROTOCOL, appId: "city", sessionId: this.room.sessionId, capability: CAPABILITY, inviteId: this.room.inviteId, deviceSecret: secret }),
    });
    if (!response.ok) throw new Error("dream_invite_unavailable");
    const grant = await response.json() as Record<string, unknown>;
    if (grant.ok !== true || grant.playerId !== "guest" || typeof grant.deviceId !== "string" || !ID.test(grant.deviceId)) throw new Error("dream_invite_invalid");
    this.storage.setItem(this.key, JSON.stringify({ deviceId: grant.deviceId, secret }));
    this.storage.removeItem(pendingKey);
  }

  /** Returns null while the owner has not approved this device (or access expired). */
  async ticket(): Promise<URL | null> {
    const grant = this.read();
    if (!grant) throw new Error("dream_not_joined");
    const response = await this.request(roomUrl(this.room, "access"), {
      method: "POST", redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${grant.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pair", deviceId: grant.deviceId }),
    });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error("dream_relay_unavailable");
    const value = await response.json() as Record<string, unknown>;
    if (value.ok !== true || typeof value.ticket !== "string" || !SECRET.test(value.ticket)) throw new Error("dream_relay_invalid");
    const url = roomUrl(this.room, "ws");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", value.ticket);
    return url;
  }

  forget(): void { this.storage.removeItem(this.key); this.storage.removeItem(`${this.key}:pending`); }
}

/** Scoped snapshot-only socket. Decoding does not replace application contract validation. */
export class DreamSnapshotChannel {
  private readonly socket: WebSocket;
  private readonly sessionId: string;
  private ready = false;
  private invalidated = false;
  private readonly channel: RemoteRequestChannel;
  private readonly onInvalidated: () => void;

  constructor(socket: WebSocket, sessionId: string, onInvalidated: () => void) {
    if (!ID.test(sessionId)) throw new Error("dream_link_invalid");
    this.socket = socket;
    this.sessionId = sessionId;
    this.onInvalidated = onInvalidated;
    this.channel = new RemoteRequestChannel(socket, { appId: "city", sessionId, capability: CAPABILITY }, MAX_FRAME, 15_000,
      () => { this.invalidated = true; this.ready = false; this.onInvalidated(); },
      value => {
        if (value.type === "ready" && value.role === "guest" && value.playerId === "guest") { this.ready = true; return; }
        if (value.type === "event" && (value.event as { type?: unknown } | null)?.type === "dream.closed") { socket.close(1000); this.channel.invalidate(); }
      });
  }

  isReady(): boolean { return this.ready; }

  async snapshot(): Promise<Uint8Array> {
    if (!this.ready || this.invalidated || this.socket.readyState !== WebSocket.OPEN) throw new Error("dream_disconnected");
    let result: unknown;
    try { result = await this.channel.request("dream.snapshot", {}); }
    catch (error) { if (error instanceof Error && error.message === "remote_disconnected") throw new Error("dream_disconnected"); throw error; }
    const response = result as { ok?: unknown; snapshot?: unknown } | null;
    if (!response || response.ok !== true) throw new Error("dream_snapshot_unavailable");
    const decoded = await decodeDreamSnapshot(response.snapshot);
    if (!this.ready || this.invalidated || this.socket.readyState !== WebSocket.OPEN) throw new Error("dream_disconnected");
    return decoded;
  }

  close(): void { this.socket.close(1000); this.channel.invalidate(); }
}
