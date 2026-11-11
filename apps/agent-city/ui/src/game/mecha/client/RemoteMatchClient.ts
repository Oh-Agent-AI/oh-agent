import type { SequentialCommand } from "../sequentialTurn";
import { parseSequentialCommandResult, parseSequentialSnapshotResult, type SequentialCommandResult, type SequentialSnapshotResult } from "../contracts/sequentialTransport";
import { RemoteRequestChannel } from "../../../remote/RemoteRequestChannel";

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;
export type RemoteConnectionState = "connecting" | "online" | "offline";
export type MechaRemoteCapability = "mecha:v4";

const browserSocket: WebSocketFactory = (url) => new WebSocket(url) as WebSocketLike;

export class RemoteMatchClient {
  private url: string;
  private readonly capability: MechaRemoteCapability;
  private readonly factory: WebSocketFactory;
  private readonly timeoutMs: number;
  private readonly reconnect?: { url: string; deviceId: string; token: string };
  private socket: WebSocketLike | null = null;
  private channel: RemoteRequestChannel | null = null;
  private connecting: Promise<void> | null = null;
  private disposed = false;
  private matchId = "";
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private state: RemoteConnectionState = "offline";
  private readonly statusListeners = new Set<(state: RemoteConnectionState) => void>();

  constructor(input: { url: string; capability?: MechaRemoteCapability; socketFactory?: WebSocketFactory; timeoutMs?: number; reconnect?: { url: string; deviceId: string; token: string } }) {
    this.url = input.url;
    if (input.capability !== undefined && input.capability !== "mecha:v4") throw new Error("invalid_capability");
    this.capability = input.capability ?? "mecha:v4";
    this.factory = input.socketFactory ?? browserSocket;
    this.timeoutMs = input.timeoutMs ?? 10_000;
    this.reconnect = input.reconnect;
  }

  async sequentialSnapshot(matchId: string): Promise<SequentialSnapshotResult> {
    if (!this.matchId) this.matchId = matchId;
    const result = parseSequentialSnapshotResult(await this.request("sequential.snapshot", { matchId }));
    return result ?? { ok: false, error: { code: "match_not_found" } };
  }

  async citySnapshot(matchId: string): Promise<unknown> {
    if (this.capability !== "mecha:v4") throw new Error("invalid_message");
    if (!this.matchId) this.matchId = matchId;
    return this.request("city.snapshot", { matchId });
  }

  async submitSequentialCommand(matchId: string, baseRevision: number, command: SequentialCommand): Promise<SequentialCommandResult> {
    if (!this.matchId) this.matchId = matchId;
    const result = parseSequentialCommandResult(await this.request("sequential.command.submit", { matchId, baseRevision, command }));
    return result ?? { ok: false, error: { code: "invalid_command" } };
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
    this.channel?.invalidate();
    this.channel = null;
    this.setState("offline");
  }

  private scheduleReconnect() {
    if (this.disposed || !this.reconnect || !this.matchId || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, 15000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.sequentialSnapshot(this.matchId).then((result) => {
        if (!result.ok) { this.scheduleReconnect(); return; }
        this.retryDelay = 1000;
      }).catch(() => this.scheduleReconnect());
    }, delay);
  }

  private async request(method: "sequential.snapshot" | "sequential.command.submit" | "city.snapshot", payload: Record<string, unknown> & { matchId: string }): Promise<unknown> {
    if (!this.matchId || payload.matchId !== this.matchId) throw new Error("match_not_found");
    try { await this.connect(); } catch (error) { this.scheduleReconnect(); throw error; }
    if (!this.channel) throw new Error("host_offline");
    return this.channel.request(method, payload).catch(error => {
      if (error instanceof Error && ["remote_timeout", "remote_disconnected"].includes(error.message)) throw new Error("host_offline");
      throw error;
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
          if (this.disposed || disconnectedOnce) { socket.close(1000, "client_disposed"); return; }
          opened = true;
          this.socket = socket;
          this.channel = new RemoteRequestChannel(socket, { appId: "city", sessionId: this.matchId, capability: this.capability }, 1_000_000, this.timeoutMs);
          this.setState("online");
          resolve();
        });
        const disconnected = () => {
          if (disconnectedOnce) return;
          disconnectedOnce = true;
          if (this.socket === socket) this.socket = null;
          this.channel?.invalidate();
          this.channel = null;
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

  private setState(state: RemoteConnectionState) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.statusListeners]) listener(state);
  }
}
