import type { RemoteHostAdapterFactory, RemoteHostContext, RemoteHostPeer, RemoteHostServices } from "../RemoteHostAdapterRegistry";
import type { DreamSnapshotEnvelopeV1 } from "./dreamSnapshotCodec";
import { REMOTE_PROTOCOL } from "../remoteEnvelope";

const CAPABILITY = "city-dream:v1";
const MAX_PLAIN_BYTES = 4 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 230 * 1024;
const DEVICE_ID = /^[a-f0-9]{64}$/;
type HostRequest = { protocol: string; appId: string; sessionId: string; capability: string; type: string; requestId: string; method: string; payload: Record<string, unknown>; peer?: RemoteHostPeer };

function validSnapshotEnvelope(value: unknown): value is DreamSnapshotEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return Object.keys(envelope).length === 3 && Object.hasOwn(envelope, "schema") && Object.hasOwn(envelope, "plainBytes") && Object.hasOwn(envelope, "data")
    && envelope.schema === "dream-city-gzip:v1" && Number.isSafeInteger(envelope.plainBytes)
    && Number(envelope.plainBytes) > 0 && Number(envelope.plainBytes) <= MAX_PLAIN_BYTES
    && typeof envelope.data === "string" && envelope.data.length > 0 && envelope.data.length <= Math.ceil((MAX_ENVELOPE_BYTES * 3 / 4) / 3) * 4
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.data)
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_ENVELOPE_BYTES;
}

function validGuest(peer: RemoteHostPeer | undefined): peer is RemoteHostPeer & { role: "guest"; deviceId: string } {
  return Boolean(peer && peer.role === "guest" && peer.playerId === "guest" && typeof peer.deviceId === "string" && DEVICE_ID.test(peer.deviceId));
}

/** Serves only the immutable, trusted TypeScript-projected scene envelope to Relay-approved guests. */
export function createDreamCityRemoteHostAdapter(context: RemoteHostContext, services: RemoteHostServices) {
  let snapshot: DreamSnapshotEnvelopeV1 | null = null;
  const respond = (request: HostRequest, result: Record<string, unknown>) => services.send({ type: "response", requestId: request.requestId, result });

  return {
    appId: "city",
    capability: CAPABILITY,
    handle(request: HostRequest) {
      if (request.protocol !== REMOTE_PROTOCOL || request.appId !== context.appId || request.sessionId !== context.sessionId
          || request.capability !== context.capability || request.type !== "request") return;
      if (request.method === "dream.bootstrap") {
        if (snapshot || Object.keys(request.payload).length !== 1 || !Array.isArray(request.payload.projections) || request.payload.projections.length !== 1) {
          respond(request, { ok: false, error: { code: "invalid_plan" } });
          return;
        }
        const projection = request.payload.projections[0] as Record<string, unknown> | null;
        if (!projection || Object.keys(projection).length !== 2 || projection.id !== CAPABILITY || !validSnapshotEnvelope(projection.value)) {
          respond(request, { ok: false, error: { code: "invalid_plan" } });
          return;
        }
        snapshot = Object.freeze({ ...projection.value });
        services.lifecycle({ type: "created" });
        return;
      }
      if (request.method !== "dream.snapshot" || !validGuest(request.peer) || Object.keys(request.payload).length !== 0 || !snapshot) {
        respond(request, { ok: false, error: { code: "unavailable" } });
        return;
      }
      respond(request, { ok: true, snapshot });
    },
    close() { snapshot = null; },
  };
}

export const DREAM_CITY_REMOTE_HOST: RemoteHostAdapterFactory = {
  appId: "city",
  capability: CAPABILITY,
  create: (context, services) => createDreamCityRemoteHostAdapter(context, services),
};
