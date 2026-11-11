import { parseRemoteEnvelope, remoteRequest, type RemoteScope } from "./remoteEnvelope";

export const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 64;

export interface RemoteSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

/** Request correlation, timeout, cancellation and invalidation shared by apps. */
export class RemoteRequestChannel {
  private sequence = 0;
  private invalidated = false;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void }>();
  private readonly scope: RemoteScope;
  private readonly socket: RemoteSocket;
  private readonly maxBytes: number;
  private readonly maxInFlightRequests: number;
  private readonly timeoutMs: number;
  private readonly onInvalidated: () => void;
  private readonly onMessage: (message: Record<string, unknown>) => void;

  constructor(socket: RemoteSocket, scope: RemoteScope, maxBytes = 256 * 1024, timeoutMs = 15_000, onInvalidated: () => void = () => {}, onMessage: (message: Record<string, unknown>) => void = () => {}, maxInFlightRequests = DEFAULT_MAX_IN_FLIGHT_REQUESTS) {
    if (!Number.isSafeInteger(maxInFlightRequests) || maxInFlightRequests < 1) throw new RangeError("remote_max_in_flight_invalid");
    this.socket = socket;
    this.scope = scope;
    this.maxBytes = maxBytes;
    this.maxInFlightRequests = maxInFlightRequests;
    this.timeoutMs = timeoutMs;
    this.onInvalidated = onInvalidated;
    this.onMessage = onMessage;
    socket.addEventListener("message", event => this.receive((event as unknown as { data?: unknown }).data));
    socket.addEventListener("close", () => this.invalidate());
    socket.addEventListener("error", () => this.invalidate());
  }

  request(method: string, payload: object, signal?: AbortSignal): Promise<unknown> {
    if (this.invalidated || (this.socket.readyState !== undefined && this.socket.readyState !== 1)) return Promise.reject(new Error("remote_disconnected"));
    if (signal?.aborted) return Promise.reject(new Error("remote_cancelled"));
    if (this.pending.size >= this.maxInFlightRequests) return Promise.reject(new Error("remote_backpressure"));
    const requestId = `remote-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        const item = this.pending.get(requestId);
        if (!item) return;
        this.pending.delete(requestId); clearTimeout(item.timer);
        if (item.signal && item.abort) item.signal.removeEventListener("abort", item.abort);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new Error("remote_timeout")), this.timeoutMs);
      const abort = () => finish(new Error("remote_cancelled"));
      this.pending.set(requestId, { resolve: value => finish(undefined, value), reject: error => finish(error), timer, signal, abort });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const message = JSON.stringify(remoteRequest(this.scope, requestId, method, payload));
        if (new TextEncoder().encode(message).byteLength > this.maxBytes) { finish(new Error("remote_message_too_large")); return; }
        this.socket.send(message);
      } catch { finish(new Error("remote_disconnected")); }
    });
  }

  invalidate(): void {
    if (this.invalidated) return;
    this.invalidated = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); if (item.signal && item.abort) item.signal.removeEventListener("abort", item.abort); item.reject(new Error("remote_disconnected")); }
    this.pending.clear(); this.onInvalidated();
  }

  private receive(data: unknown): void {
    if (this.invalidated) return;
    const value = parseRemoteEnvelope(data, this.scope, this.maxBytes);
    if (!value) { this.socket.close(1008, "invalid_remote_envelope"); this.invalidate(); return; }
    if (value.type === "response") {
      if (typeof value.requestId === "string") this.pending.get(value.requestId)?.resolve(value.result);
      return;
    }
    this.onMessage(value);
  }
}
