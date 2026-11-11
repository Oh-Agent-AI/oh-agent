import { DREAM_SNAPSHOT_MAX_ENVELOPE_BYTES, DREAM_SNAPSHOT_MAX_PLAIN_BYTES, type DreamSnapshotEnvelopeV1 } from "./dreamSnapshotCodec";

const CAPABILITY = "city-dream:v1";
const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const DEVICE_ID = /^[A-Za-z0-9:_-]{1,80}$/;

type RemoteRequest = (method: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
const defaultRemoteRequest: RemoteRequest = async (method, payload) => (await import("../pluginRequest")).pluginRequest(method, payload);

export type DreamOwnerSession = {
  sessionId: string;
  inviteUrl: string;
  expiresIn: number;
};

export type DreamPendingVisitor = { deviceId: string; playerId: "guest" };

function validEnvelope(value: unknown): value is DreamSnapshotEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return Object.keys(envelope).length === 3 && envelope.schema === "dream-city-gzip:v1"
    && Number.isSafeInteger(envelope.plainBytes) && Number(envelope.plainBytes) > 0 && Number(envelope.plainBytes) <= DREAM_SNAPSHOT_MAX_PLAIN_BYTES
    && typeof envelope.data === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.data)
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= DREAM_SNAPSHOT_MAX_ENVELOPE_BYTES;
}

function validRelay(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value.replace(/\/$/, "") && !url.username && !url.password
      && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}

function sessionId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("remote_response_invalid");
  return value;
}

function deviceId(value: unknown): string {
  if (typeof value !== "string" || !DEVICE_ID.test(value)) throw new Error("remote_response_invalid");
  return value;
}

function invitationUrl(value: unknown, expectedOrigin?: string): string {
  if (typeof value !== "string") throw new Error("remote_response_invalid");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("remote_response_invalid"); }
  const oneParam = (name: string) => url.searchParams.getAll(name).length === 1;
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || url.username || url.password || (expectedOrigin && url.origin !== expectedOrigin) || url.searchParams.get("capability") !== CAPABILITY
      || !["capability", "room", "publication", "invite"].every(oneParam)
      || !ID.test(url.searchParams.get("room") ?? "") || !ID.test(url.searchParams.get("publication") ?? "")
      || !ID.test(url.searchParams.get("invite") ?? "") || !/^#[a-f0-9]{64}$/.test(url.hash)) throw new Error("remote_response_invalid");
  return url.toString();
}

/** Owner-side calls for Dream publication. Rust remains authoritative for session and visitor access. */
export class DreamOwnerRemoteClient {
  private readonly request: RemoteRequest;
  private readonly relayOrigins = new Map<string, string>();

  constructor(request: RemoteRequest = defaultRemoteRequest) { this.request = request; }

  async start(input: { relay: string; envelope: DreamSnapshotEnvelopeV1; confirmed: true }): Promise<DreamOwnerSession> {
    if (!input || input.confirmed !== true || !validRelay(input.relay) || !validEnvelope(input.envelope)) throw new Error("dream_publication_confirmation_required");
    const result = await this.request("remote.session.start", {
      capabilityId: CAPABILITY,
      relay: input.relay.replace(/\/$/, ""),
      bootstrap: { projections: [{ id: CAPABILITY, value: input.envelope }] },
    });
    if (result.ok !== true) throw new Error("remote_response_invalid");
    const id = sessionId(result.sessionId);
    // Creating an invite is separate from session startup so the caller can
    // reveal a shareable link only after the trusted host is connected.
    try {
      if (typeof result.remoteUrl !== "string" || result.connection !== "connecting") throw new Error("remote_response_invalid");
      const ownerUrl = new URL(result.remoteUrl);
      const relayUrl = new URL(input.relay.replace(/\/$/, ""));
      if (ownerUrl.origin !== relayUrl.origin || ownerUrl.protocol !== relayUrl.protocol) throw new Error("remote_response_invalid");
      this.relayOrigins.set(id, relayUrl.origin);
      return await this.invite(id);
    }
    catch (error) { await this.stop(id).catch(() => {}); this.relayOrigins.delete(id); throw error; }
  }

  async invite(id: string): Promise<DreamOwnerSession> {
    const scopedId = sessionId(id);
    const result = await this.request("remote.session.invite", { capabilityId: CAPABILITY, sessionId: scopedId });
    if (result.ok !== true || !Number.isSafeInteger(result.expiresIn) || Number(result.expiresIn) < 1) throw new Error("remote_response_invalid");
    return { sessionId: scopedId, inviteUrl: invitationUrl(result.inviteUrl, this.relayOrigins.get(scopedId)), expiresIn: Number(result.expiresIn) };
  }

  async pending(id: string): Promise<DreamPendingVisitor[]> {
    const result = await this.request("remote.session.pending", { capabilityId: CAPABILITY, sessionId: sessionId(id) });
    if (result.ok !== true || !Array.isArray(result.pending)) throw new Error("remote_response_invalid");
    return result.pending.map((entry): DreamPendingVisitor => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("remote_response_invalid");
      const visitor = entry as Record<string, unknown>;
      if (visitor.playerId !== "guest") throw new Error("remote_response_invalid");
      return { deviceId: deviceId(visitor.deviceId), playerId: "guest" };
    });
  }

  async approve(id: string, visitorId: string): Promise<void> { await this.access("approve", id, visitorId); }
  async revoke(id: string, visitorId: string): Promise<void> { await this.access("revoke", id, visitorId); }

  async stop(id: string): Promise<void> {
    const result = await this.request("remote.session.stop", { capabilityId: CAPABILITY, sessionId: sessionId(id) });
    if (result.ok !== true) throw new Error("remote_response_invalid");
    this.relayOrigins.delete(id);
  }

  private async access(action: "approve" | "revoke", id: string, visitorId: string): Promise<void> {
    const result = await this.request(`remote.session.${action}`, {
      capabilityId: CAPABILITY, sessionId: sessionId(id), deviceId: deviceId(visitorId),
    });
    if (result.ok !== true) throw new Error("remote_response_invalid");
  }
}

export const dreamOwnerRemoteContract = Object.freeze({ capability: CAPABILITY });
