import { MECHA_NET_PROTOCOL, parseSubmitDeployment, parseSubmitPlan, type MatchMode, type MatchPlayer, type RevisionState } from "../game/mecha/contracts/match";
import { deploymentResult, snapshotResult, turnResult, type RemoteNotification, type RemoteRequest } from "../game/mecha/contracts/transport";
import { MatchSession, pveRules } from "../game/mecha/session/MatchSession";
import type { MatchState } from "../game/mecha/rules";
import { hasUnsupportedRemoteSummons, type RemoteArenaV1 } from "../game/mecha/contracts/arena";

type HostConfig = {
  matchId: string;
  mode: MatchMode;
  arena: RemoteArenaV1;
  state: MatchState;
  players: MatchPlayer[];
};
type SessionRemoteRequest = Omit<RemoteRequest, "method"> & { method: RemoteRequest["method"] | "match.create" | "match.join" };
type SessionRequest = { token: string; request: SessionRemoteRequest };
type SessionReply = { type: "ready" | "created"; token: string } | { type: "joined"; token: string; ok: boolean } | { type: "message"; token: string; message: unknown };
declare global {
  interface Window {
    __AV_MECHA_SESSION_TOKEN__?: string;
    __TAURI__?: { core?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } };
  }
}

const error = (code: "unavailable" | "invalid_message" | "invalid_plan" | "forbidden") => ({ ok: false as const, error: { code } });

export function startRemoteSessionHost() {
  let session: MatchSession<MatchState> | null = null;
  let unsubscribe: (() => void) | null = null;
  const attach = <S extends RevisionState>(next: MatchSession<S>) => {
    unsubscribe?.();
    session = next as unknown as MatchSession<MatchState>;
    unsubscribe = next.subscribe((event) => {
      const notification: RemoteNotification<RevisionState> = { protocol: MECHA_NET_PROTOCOL, type: "event", event: event as RemoteNotification<RevisionState>["event"] };
      send(notification);
    });
  };
  const token = window.__AV_MECHA_SESSION_TOKEN__ ?? "";
  const invoke = window.__TAURI__?.core?.invoke;
  if (!token || !invoke) {
    document.body.textContent = "Remote MatchSession requires the desktop host.";
    return;
  }
  const send = (message: unknown) => {
    const reply: SessionReply = { type: "message", token, message };
    void invoke("remote_mecha_message", { reply }).catch(() => {});
  };
  const resultError = (request: SessionRemoteRequest, code: "invalid_message" | "invalid_plan" | "unavailable" | "forbidden") => {
    send({ protocol: MECHA_NET_PROTOCOL, type: "response", requestId: request.requestId, result: error(code) });
  };
  window.addEventListener("__AV_MECHA_REMOTE_REQUEST__", ((event: CustomEvent<SessionRequest>) => {
    const { request, token: sender } = event.detail ?? {};
    if (sender !== token || !request || request.protocol !== MECHA_NET_PROTOCOL || request.type !== "request") return;
    const payload = request.payload as Record<string, unknown>;
    if (request.method === "match.create") {
      if (session || !payload.config) { resultError(request, "unavailable"); return; }
      const config = payload.config as HostConfig;
      if (config.mode !== "pve" || config.arena?.ruleset !== "mecha-v1.4" || config.state?.ruleset !== "mecha-v1.4" || "mission" in config.state || Object.hasOwn(config.state, "monsterContent") || hasUnsupportedRemoteSummons(config.state)) {
        resultError(request, "invalid_plan"); return;
      }
      try {
        attach(new MatchSession({ matchId: config.matchId, mode: "pve", arena: config.arena, state: config.state, players: config.players, rules: pveRules }));
        const created: SessionReply = { type: "created", token };
        void invoke("remote_mecha_message", { reply: created });
      } catch {
        session = null;
        resultError(request, "invalid_plan");
      }
      return;
    }
    if (request.method === "match.join") {
      const joined = (ok: boolean) => { const reply: SessionReply = { type: "joined", token, ok }; void invoke("remote_mecha_message", { reply }); };
      joined(false);
      return;
    }
    if (!session) { resultError(request, "unavailable"); return; }
    const playerId = typeof payload.playerId === "string" ? payload.playerId : "";
    let result;
    if (request.method === "match.snapshot") {
      const snapshot = session.snapshot(playerId);
      result = snapshot.ok && snapshot.value.matchId === payload.matchId ? snapshot : error("unavailable");
      if (!snapshotResult(result)) { resultError(request, "invalid_message"); return; }
    } else if (request.method === "match.close") {
      const snapshot = session.snapshot(playerId);
      result = snapshot.ok && snapshot.value.matchId === payload.matchId ? session.close(playerId) : error("forbidden");
      if (!snapshotResult(result)) { resultError(request, "invalid_message"); return; }
    } else if (request.method === "deployment.submit") {
      const command = parseSubmitDeployment(payload);
      result = command.ok ? session.submitDeployment(playerId, command.value) : command;
      if (!deploymentResult(result)) { resultError(request, "invalid_message"); return; }
    } else if (request.method === "plan.submit") {
      const command = parseSubmitPlan(payload);
      result = command.ok ? session.submitPlan(playerId, command.value) : command;
      if (!turnResult(result as { ok: boolean })) { resultError(request, "invalid_message"); return; }
    } else {
      resultError(request, "invalid_message"); return;
    }
    send({ protocol: MECHA_NET_PROTOCOL, type: "response", requestId: request.requestId, result });
  }) as EventListener);
  const ready: SessionReply = { type: "ready", token };
  void invoke("remote_mecha_message", { reply: ready });
}
