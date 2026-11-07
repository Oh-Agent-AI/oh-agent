import type { PluginRequestV1, PluginResponseV1 } from "@agent-vitals/app-sdk";
import { invokeHost } from "../../host";

export type RemoteMechaStatus = "idle" | "starting" | "active" | "stopping" | "unknown";
let sequence = 0;

/** Shared host bridge for handoff control calls; no game state crosses this function. */
export async function remoteRequest(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const request: PluginRequestV1 = {
    version: 1,
    instanceId: window.__AV_PLUGIN_INSTANCE__ ?? "",
    requestId: `mecha-remote-${++sequence}`,
    method,
    payload,
  };
  const response = await invokeHost<PluginResponseV1<Record<string, unknown>>>("plugin_request", { request });
  if (response.version !== 1 || response.requestId !== request.requestId) throw new Error("plugin_response_invalid");
  if (!response.ok || !response.result) throw new Error(response.error?.code ?? "remote_unavailable");
  return response.result;
}
