import { SEQUENTIAL_NET_PROTOCOL, type SequentialRequest, type SequentialResponse } from "../contracts/sequentialTransport";
import { SequentialMatchSession } from "./SequentialMatchSession";

/** Pure v2 host: transport is injected by the caller; messages never carry a site object. */
export class SequentialRemoteHost {
  private readonly session: SequentialMatchSession;
  private frozen = false;
  constructor(session: SequentialMatchSession) { this.session = session; }
  /** Called by the local host during handback, before the session is closed. */
  freezeAndSnapshot() {
    this.frozen = true;
    return this.session.snapshot();
  }
  handle(message: unknown): SequentialResponse | null {
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    const request = message as Partial<SequentialRequest>;
    if (request.protocol !== SEQUENTIAL_NET_PROTOCOL || request.type !== "request" || typeof request.requestId !== "string") return null;
    const payload = request.payload;
    if (!payload || typeof payload !== "object" || typeof payload.matchId !== "string") return null;
    if (payload.matchId !== this.session.matchId) return { protocol: SEQUENTIAL_NET_PROTOCOL, type: "response", requestId: request.requestId, result: { ok: false, error: { code: "match_not_found" } } };
    if (request.method === "sequential.snapshot") return { protocol: SEQUENTIAL_NET_PROTOCOL, type: "response", requestId: request.requestId, result: this.session.snapshot() };
    if (request.method === "sequential.command.submit") {
      if (!Number.isSafeInteger(payload.baseRevision) || !payload.command) return null;
      if (this.frozen) return { protocol: SEQUENTIAL_NET_PROTOCOL, type: "response", requestId: request.requestId, result: { ok: false, error: { code: "invalid_command" } } };
      const result = this.session.submit(payload.baseRevision as number, payload.command as Parameters<SequentialMatchSession["submit"]>[1]);
      return { protocol: SEQUENTIAL_NET_PROTOCOL, type: "response", requestId: request.requestId, result };
    }
    return null;
  }
}
