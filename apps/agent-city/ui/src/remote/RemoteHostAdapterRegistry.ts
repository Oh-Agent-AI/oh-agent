export type RemoteHostPeer = { role: "owner" | "guest"; playerId: string; deviceId?: string };
export type RemoteHostRequest = {
  appId: string;
  capability: string;
  sessionId: string;
  token: string;
  request: { protocol: string; appId: string; sessionId: string; capability: string; type: string; requestId: string; method: string; payload: Record<string, unknown>; peer?: RemoteHostPeer };
};

export type RemoteHostAdapter = {
  appId: string;
  capability: string;
  handle(request: RemoteHostRequest["request"]): void | Promise<void>;
  start?(signal: AbortSignal): void | Promise<void>;
  onError?(request: RemoteHostRequest["request"], code: "unavailable" | "backpressure"): void;
  close?(): void;
};

export type RemoteHostContext = { appId: string; capability: string; sessionId: string; token: string };
export type RemoteHostServices = {
  signal: AbortSignal;
  send(message: unknown): void;
  lifecycle(reply: { type: "created" } | { type: "joined"; ok: boolean } | { type: "frozen"; snapshot: unknown }): void;
};
export type RemoteHostAdapterFactory = {
  appId: string;
  capability: string;
  create(context: RemoteHostContext, services: RemoteHostServices): RemoteHostAdapter;
};

export function resolveRemoteHostAdapter(context: Pick<RemoteHostContext, "appId" | "capability">, factories: readonly RemoteHostAdapterFactory[]): RemoteHostAdapterFactory | null {
  const matches = factories.filter(factory => factory.appId === context.appId && factory.capability === context.capability);
  return matches.length === 1 ? matches[0]! : null;
}

const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const DEVICE_ID = /^[a-f0-9]{64}$/;

function validPeer(value: unknown): value is RemoteHostPeer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const peer = value as Record<string, unknown>;
  const keys = Object.keys(peer);
  return keys.every(key => key === "role" || key === "playerId" || key === "deviceId")
    && (peer.role === "owner" || peer.role === "guest") && typeof peer.playerId === "string" && ID.test(peer.playerId)
    && (peer.deviceId === undefined || (typeof peer.deviceId === "string" && DEVICE_ID.test(peer.deviceId)));
}

/** Dispatches generic host requests only to the adapter registered for their scope. */
export class RemoteHostAdapterRegistry {
  private readonly adapters = new Map<string, RemoteHostAdapter>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private ready = true;
  private closed = false;
  private readonly maxPending = 64;

  pause(): void { this.ready = false; }
  resume(): void { if (!this.closed) this.ready = true; }
  close(): void { this.closed = true; this.ready = false; }

  register(adapter: RemoteHostAdapter): () => void {
    if (!ID.test(adapter.appId) || !ID.test(adapter.capability) || typeof adapter.handle !== "function") throw new Error("remote_host_adapter_invalid");
    const key = `${adapter.appId}\0${adapter.capability}`;
    if (this.adapters.has(key)) throw new Error("remote_host_adapter_duplicate");
    this.adapters.set(key, adapter);
    return () => { if (this.adapters.get(key) === adapter) this.adapters.delete(key); };
  }

  async dispatch(value: unknown, expected: { token: string; appId: string; capability: string; sessionId: string }): Promise<boolean> {
    if (this.closed || !this.ready || !value || typeof value !== "object" || Array.isArray(value)) return false;
    const request = value as Partial<RemoteHostRequest>;
    if (request.token !== expected.token || request.appId !== expected.appId || request.capability !== expected.capability
        || request.sessionId !== expected.sessionId || !ID.test(request.sessionId ?? "") || !request.request
        || typeof request.request !== "object" || request.request.type !== "request"
        || request.request.protocol !== "app-remote:v1" || request.request.appId !== expected.appId
        || request.request.sessionId !== expected.sessionId || request.request.capability !== expected.capability
        || typeof request.request.requestId !== "string"
        || !ID.test(request.request.requestId) || typeof request.request.method !== "string"
        || !request.request.payload || typeof request.request.payload !== "object" || Array.isArray(request.request.payload)
        || (request.request.peer !== undefined && !validPeer(request.request.peer))) return false;
    const hostRequest = request.request;
    const adapter = this.adapters.get(`${request.appId}\0${request.capability}`);
    if (!adapter) return false;
    if (this.pending >= this.maxPending) {
      try { adapter.onError?.(hostRequest, "backpressure"); } catch { /* error reporting must not break routing */ }
      return false;
    }
    this.pending += 1;
    const operation = this.tail.then(async () => {
      if (this.closed || !this.ready) return;
      try { await adapter.handle(hostRequest); }
      catch {
        if (!this.closed) {
          try { adapter.onError?.(hostRequest, "unavailable"); } catch { /* adapter errors are contained */ }
        }
      }
    });
    this.tail = operation.catch(() => {});
    try { await operation; return !this.closed; }
    finally { this.pending -= 1; }
  }
}
