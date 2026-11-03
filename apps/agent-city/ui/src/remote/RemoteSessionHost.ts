import { MECHA_NET_PROTOCOL, parseSubmitConcede, parseSubmitDeployment, parseSubmitPlan, type MatchMode, type MatchPlayer, type RevisionState } from "../game/mecha/contracts/match";
import { deploymentResult, snapshotResult, turnResult, type RemoteNotification, type RemoteRequest } from "../game/mecha/contracts/transport";
import { MatchSession, pveRules } from "../game/mecha/session/MatchSession";
import type { MatchState } from "../game/mecha/rules";
import type { RemoteArenaV1 } from "../game/mecha/contracts/arena";
import { PVP_RULESET, createPvpMatch, pvpRules, type PvpState } from "../game/mecha/rules/pvp";

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
  let session: MatchSession<MatchState> | MatchSession<PvpState> | null = null;
  let unsubscribe: (() => void) | null = null;
  const attach = <S extends RevisionState>(next: MatchSession<S>) => {
    unsubscribe?.();
    session = next as unknown as MatchSession<MatchState> | MatchSession<PvpState>;
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
      if (config.mode !== "pve" || config.arena?.ruleset !== "mecha-v1.4" || config.state?.ruleset !== "mecha-v1.4") {
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
      if (!session || payload.playerId !== "guest") { joined(false); return; }
      const before = session.snapshot("owner");
      if (!before.ok || before.value.matchId !== payload.matchId) { joined(false); return; }
      if (before.value.mode === "pvp") { joined(true); return; }
      // A PvP invitation must never silently replace an unfinished PvE deployment.
      if ("phase" in before.value.state && before.value.state.phase === "deployment") { joined(false); return; }
      // The same matchId is reused: never let a delayed PvE command's baseRevision
      // become valid again in the replacement PvP session.
      if (!Number.isSafeInteger(before.value.revision) || before.value.revision >= Number.MAX_SAFE_INTEGER - 1) { joined(false); return; }
      try {
        const pvpState = createPvpMatch(before.value.arena);
        pvpState.revision = before.value.revision + 1;
        const next = new MatchSession({
          matchId: before.value.matchId, mode: "pvp", arena: { ...before.value.arena, ruleset: PVP_RULESET },
          state: pvpState, players: [...before.value.players, { playerId: "guest", side: "B", role: "guest" }], rules: pvpRules,
        });
        attach(next);
        const replacement = next.snapshot("owner");
        if (replacement.ok) {
          send({ protocol: MECHA_NET_PROTOCOL, type: "event", event: { type: "match.replaced", snapshot: replacement.value } });
        }
        joined(true);
      } catch { joined(false); }
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
    } else if (request.method === "match.concede") {
      // Legacy requests have no revision or command ID. An in-flight request could
      // otherwise concede a replacement match or a later turn: fail closed.
      result = error("unavailable");
    } else if (request.method === "match.concede-v2") {
      // The gateway must bind the authenticated peer and the v3 capability.
      const command = parseSubmitConcede(payload);
      result = command.ok ? session.submitConcede(playerId, command.value) : command;
      if (!turnResult(result as { ok: boolean })) { resultError(request, "invalid_message"); return; }
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
