import { MECHA_NET_PROTOCOL, type MatchEvent, type MatchResult, type MatchSnapshot, type SubmitPlanCommand, type TurnResolved } from "../contracts/match";
import type { RevisionState } from "../contracts/match";
import { parseRemoteMessage, snapshotResult, turnResult, type RemoteMethod } from "../contracts/transport";
import type { MatchClient } from "./MatchClient";

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: never) => void): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;
export type RemoteConnectionState = "connecting" | "online" | "offline";

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
const browserSocket: WebSocketFactory = (url) => new WebSocket(url) as WebSocketLike;

export class RemoteMatchClient<S extends RevisionState = RevisionState> implements MatchClient<S> {
  private url: string;
  private readonly playerId: string;
  private readonly factory: WebSocketFactory;
  private readonly timeoutMs: number;
  private readonly reconnect?: { url: string; deviceId: string; token: string };
  private socket: WebSocketLike | null = null;
  private connecting: Promise<void> | null = null;
  private sequence = 0;
  private disposed = false;
  private matchId = "";
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private state: RemoteConnectionState = "offline";
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: MatchEvent<S>) => void>();
  private readonly statusListeners = new Set<(state: RemoteConnectionState) => void>();

  constructor(input: { url: string; playerId: string; socketFactory?: WebSocketFactory; timeoutMs?: number; reconnect?: { url: string; deviceId: string; token: string } }) {
    this.url = input.url;
    this.playerId = input.playerId;
    this.factory = input.socketFactory ?? browserSocket;
    this.timeoutMs = input.timeoutMs ?? 10_000;
    this.reconnect = input.reconnect;
  }

  async snapshot(matchId: string): Promise<MatchResult<MatchSnapshot<S>>> {
    if (this.matchId && this.matchId !== matchId) throw new Error("match_not_found");
    this.matchId = matchId;
    const result = snapshotResult<S>(await this.request("match.snapshot", { matchId, playerId: this.playerId }));
    return result ?? { ok: false, error: { code: "invalid_message" } };
  }

  async submitPlan(command: SubmitPlanCommand): Promise<MatchResult<TurnResolved<S>>> {
    const result = turnResult<S>(await this.request("plan.submit", command));
    return result ?? { ok: false, error: { code: "invalid_message" } };
  }

  async concede(matchId: string): Promise<MatchResult<TurnResolved<S>>> {
    const result = turnResult<S>(await this.request("match.concede", { matchId, playerId: this.playerId }));
    return result ?? { ok: false, error: { code: "invalid_message" } };
  }

  async close(matchId: string): Promise<MatchResult<MatchSnapshot<S>>> {
    const result = snapshotResult<S>(await this.request("match.close", { matchId, playerId: this.playerId }));
    return result ?? { ok: false, error: { code: "invalid_message" } };
  }

  subscribe(listener: (event: MatchEvent<S>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (state: RemoteConnectionState) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.state);
    return () => this.statusListeners.delete(listener);
  }

  dispose() {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket?.close(1000, "client_disposed");
    this.failPending(new Error("host_offline"));
    this.setState("offline");
  }

  private scheduleReconnect() {
    if (this.disposed || !this.reconnect || !this.matchId || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, 15000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.snapshot(this.matchId).then((result) => {
        if (!result.ok) { this.scheduleReconnect(); return; }
        this.retryDelay = 1000;
        for (const listener of [...this.listeners]) listener({ type: "match.replaced", snapshot: structuredClone(result.value) });
      }).catch(() => this.scheduleReconnect());
    }, delay);
  }

  private async request(method: RemoteMethod, payload: { matchId: string; playerId?: string }): Promise<unknown> {
    if (!this.matchId || payload.matchId !== this.matchId) throw new Error("match_not_found");
    try { await this.connect(); } catch (error) { this.scheduleReconnect(); throw error; }
    const requestId = `remote-${++this.sequence}`;
    const request = { protocol: "app-remote:v1", appId: "city", sessionId: this.matchId, capability: "mecha:v1", type: "request", requestId, method, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("host_offline"));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket!.send(JSON.stringify(request));
    });
  }

  private async socketUrl(): Promise<string> {
    if (!this.reconnect) return this.url;
    let reply: Response;
    try {
      reply = await fetch(this.reconnect.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.reconnect.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pair", deviceId: this.reconnect.deviceId }),
        cache: "no-store",
      });
    } catch {
      throw new Error("host_offline");
    }
    if (!reply.ok) throw new Error("host_offline");
    const body = await reply.json().catch(() => null) as { ticket?: unknown } | null;
    if (!body || typeof body.ticket !== "string" || !body.ticket) throw new Error("host_offline");
    const url = new URL(this.url);
    url.searchParams.set("ticket", body.ticket);
    return url.toString();
  }

  private async connect(): Promise<void> {
    if (this.disposed) throw new Error("host_offline");
    if (this.socket) return;
    if (this.connecting) return this.connecting;
    this.setState("connecting");
    const connecting = (async () => {
      const url = await this.socketUrl();
      if (this.disposed) throw new Error("host_offline");
      await new Promise<void>((resolve, reject) => {
        const socket = this.factory(url);
        let opened = false;
        let disconnectedOnce = false;
        socket.addEventListener("open", () => {
          if (this.disposed) { socket.close(1000, "client_disposed"); return; }
          opened = true;
          this.socket = socket;
          this.setState("online");
          resolve();
        });
        socket.addEventListener("message", (event) => {
          const data = (event as unknown as { data?: unknown }).data;
          if (typeof data !== "string" || data.length > 1_000_000) return;
          try {
            const envelope = JSON.parse(data) as Record<string, unknown> | null;
            if (!envelope || envelope.protocol !== "app-remote:v1" || envelope.appId !== "city" || envelope.sessionId !== this.matchId || envelope.capability !== "mecha:v1") return;
            const message = parseRemoteMessage({ ...envelope, protocol: MECHA_NET_PROTOCOL });
            if (!message) return;
            if (message.type === "response") {
              const pending = this.pending.get(message.requestId);
              if (!pending) return;
              this.pending.delete(message.requestId);
              clearTimeout(pending.timer);
              pending.resolve(message.result);
            } else {
              for (const listener of [...this.listeners]) listener(structuredClone(message.event as MatchEvent<S>));
            }
          } catch { /* malformed network payloads are ignored */ }
        });
        const disconnected = () => {
          if (disconnectedOnce) return;
          disconnectedOnce = true;
          if (this.socket === socket) this.socket = null;
          this.failPending(new Error("host_offline"));
          this.setState("offline");
          this.scheduleReconnect();
          if (!opened || this.disposed) reject(new Error("host_offline"));
        };
        socket.addEventListener("error", disconnected);
        socket.addEventListener("close", disconnected);
      });
    })();
    this.connecting = connecting;
    try {
      await connecting;
    } catch (error) {
      this.setState("offline");
      throw error;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }

  private failPending(reason: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }

  private setState(state: RemoteConnectionState) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.statusListeners]) listener(state);
  }
}
