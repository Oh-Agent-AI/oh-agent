import { SEQUENTIAL_NET_PROTOCOL } from "../game/mecha/contracts/sequentialTransport";
import { SequentialMatchSession } from "../game/mecha/session/SequentialMatchSession";
import { SequentialRemoteHost } from "../game/mecha/session/SequentialRemoteHost";
import type { MatchState } from "../game/mecha/rules";
import type { DeployPlacement } from "../game/mecha/deployment";
import type { SequentialCommand } from "../game/mecha/sequentialTurn";
import type { RemoteHostAdapterFactory, RemoteHostContext, RemoteHostServices } from "./RemoteHostAdapterRegistry";
import { REMOTE_PROTOCOL } from "./remoteEnvelope";
import { validateRemoteCityDisplay } from "./city/trustedRemoteCityDisplay";

type HostBootstrap = { ruleset: "mecha-v1.5"; initial: MatchState; placements: DeployPlacement[]; commands?: SequentialCommand[]; citySite: unknown; projections: Array<{ id: string; value: unknown }> };
type HostRequest = { protocol: string; appId: string; sessionId: string; capability: string; type: string; requestId: string; method: string; payload: Record<string, unknown> };

export function createMechaV15RemoteHostAdapter(context: RemoteHostContext, services: RemoteHostServices) {
  let host: SequentialRemoteHost | null = null;
  let frozen: unknown = null;
  const resultError = (request: HostRequest, code: "invalid_message" | "invalid_plan" | "unavailable") => {
    services.send({ type: "response", requestId: request.requestId, result: { ok: false, error: { code } } });
  };

  return {
    appId: "city",
    capability: "mecha:v4",
    handle(request: HostRequest) {
      if (request.protocol !== REMOTE_PROTOCOL || request.appId !== context.appId || request.sessionId !== context.sessionId
          || request.capability !== context.capability || request.type !== "request") return;
      const payload = request.payload ?? {};
      if (request.method === "session.bootstrap") {
        if (host) { resultError(request, "unavailable"); return; }
        const config = payload as unknown as HostBootstrap;
        if (config.ruleset !== "mecha-v1.5" || !config.initial || !Array.isArray(config.placements) || !Array.isArray(config.commands)
            || !config.citySite || !Array.isArray(config.projections) || config.projections.length !== 1 || config.projections[0]?.id !== "city-remote-display:v2") { resultError(request, "invalid_plan"); return; }
        try {
          const cityDisplay = config.projections[0].value as Record<string, unknown>;
          validateRemoteCityDisplay(cityDisplay);
          const cityScene = { ...cityDisplay, site: config.citySite };
          host = new SequentialRemoteHost(new SequentialMatchSession(context.sessionId, config.initial, config.placements, config.commands), cityScene);
          services.lifecycle({ type: "created" });
        } catch {
          host = null;
          resultError(request, "invalid_plan");
        }
        return;
      }
      if (request.method === "session.join") {
        services.lifecycle({ type: "joined", ok: false });
        return;
      }
      if (!host) { resultError(request, "unavailable"); return; }
      if (request.method === "session.freeze") {
        if (frozen === null) {
          const result = host.freezeAndSnapshot();
          if (!result.ok) { resultError(request, "unavailable"); return; }
          frozen = result.snapshot;
        }
        services.lifecycle({ type: "frozen", snapshot: frozen });
        return;
      }
      const mechaMethod = request.method === "sequential.snapshot" || request.method === "sequential.command.submit" || request.method === "city.snapshot"
        ? request.method : null;
      if (!mechaMethod) { resultError(request, "invalid_message"); return; }
      const response = host.handle({ protocol: SEQUENTIAL_NET_PROTOCOL, type: "request", requestId: request.requestId, method: mechaMethod, payload });
      if (!response) { resultError(request, "invalid_message"); return; }
      services.send(response);
    },
    close() {
      host = null;
    },
  };
}

export const MECHA_V15_REMOTE_HOST: RemoteHostAdapterFactory = {
  appId: "city",
  capability: "mecha:v4",
  create: (context, services) => createMechaV15RemoteHostAdapter(context, services),
};
