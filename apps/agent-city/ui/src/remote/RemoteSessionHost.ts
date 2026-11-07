import { SEQUENTIAL_NET_PROTOCOL } from "../game/mecha/contracts/sequentialTransport";
import { SequentialMatchSession } from "../game/mecha/session/SequentialMatchSession";
import { SequentialRemoteHost } from "../game/mecha/session/SequentialRemoteHost";
import type { MatchState } from "../game/mecha/rules";
import type { DeployPlacement } from "../game/mecha/deployment";
import type { SequentialCommand } from "../game/mecha/sequentialTurn";

type HostConfig = { matchId: string; ruleset: "mecha-v1.5"; initial: MatchState; placements: DeployPlacement[]; commands?: SequentialCommand[] };
type SessionRequest = { token: string; request: { protocol: string; type: string; requestId: string; method: string; payload: Record<string, unknown> } };
type SessionReply = { type: "ready" | "created"; token: string } | { type: "joined"; token: string; ok: boolean } | { type: "message"; token: string; message: unknown };
declare global {
  interface Window {
    __AV_MECHA_SESSION_TOKEN__?: string;
    __TAURI__?: { core?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } };
  }
}

/** v1.5-only desktop host. Old capability links never reach this page. */
export function startRemoteSessionHost() {
  let host: SequentialRemoteHost | null = null;
  const token = window.__AV_MECHA_SESSION_TOKEN__ ?? "";
  const invoke = window.__TAURI__?.core?.invoke;
  if (!token || !invoke) {
    document.body.textContent = "Remote MatchSession requires the desktop host.";
    return;
  }
  const send = (message: unknown) => void invoke("remote_mecha_message", { reply: { type: "message", token, message } as SessionReply }).catch(() => {});
  const resultError = (request: SessionRequest["request"], code: "invalid_message" | "invalid_plan" | "unavailable" | "forbidden") => {
    send({ protocol: SEQUENTIAL_NET_PROTOCOL, type: "response", requestId: request.requestId, result: { ok: false, error: { code } } });
  };
  window.addEventListener("__AV_MECHA_REMOTE_REQUEST__", ((event: CustomEvent<SessionRequest>) => {
    const { request, token: sender } = event.detail ?? {};
    if (sender !== token || !request || request.protocol !== SEQUENTIAL_NET_PROTOCOL || request.type !== "request") return;
    const payload = request.payload ?? {};
    if (request.method === "match.create") {
      if (host || !payload.config) { resultError(request, "unavailable"); return; }
      const config = payload.config as HostConfig;
      if (config.ruleset !== "mecha-v1.5" || !config.initial || !Array.isArray(config.placements)) { resultError(request, "invalid_plan"); return; }
      try {
        host = new SequentialRemoteHost(new SequentialMatchSession(config.matchId, config.initial, config.placements, config.commands ?? []));
        void invoke("remote_mecha_message", { reply: { type: "created", token } as SessionReply });
      } catch {
        host = null;
        resultError(request, "invalid_plan");
      }
      return;
    }
    if (request.method === "match.join") {
      void invoke("remote_mecha_message", { reply: { type: "joined", token, ok: false } as SessionReply });
      return;
    }
    if (!host) { resultError(request, "unavailable"); return; }
    const response = host.handle({ protocol: SEQUENTIAL_NET_PROTOCOL, type: "request", requestId: request.requestId, method: request.method as "sequential.snapshot" | "sequential.command.submit", payload });
    if (!response) { resultError(request, "invalid_message"); return; }
    send(response);
  }) as EventListener);
  void invoke("remote_mecha_message", { reply: { type: "ready", token } as SessionReply });
}
