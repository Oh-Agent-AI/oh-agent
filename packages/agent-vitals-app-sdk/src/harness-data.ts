/** Installation mechanism is deliberately absent; ids are opaque to consumers. */
export type HarnessPublicIdentityV1 = {
  id: string;
  display_name: string;
  capabilities: {
    session_statistics: { available: boolean };
    findings: { available: boolean; reason: string | null };
  };
};
export type HarnessListV1 = { protocol: "harnesses:v1"; data_revision: number; harnesses: HarnessPublicIdentityV1[] };
export type HarnessSessionsV1 = {
  protocol: "harness-sessions:v1"; data_revision: number; harness_id: string;
  window: { days: 7 | 30 | 90 | 366; from_ms: number; to_ms: number };
  status: "ready" | "empty";
  coverage: { total: number; returned: number; truncated: boolean };
  sessions: Array<{ id: string; harness_id: string; first_event_at_ms: number; last_event_at_ms: number;
    event_count: number; tokens: { input: number; output: number; total: number } }>;
};

import type { PluginRequestV1, PluginResponseV1 } from "./plugin-rpc.js";
/** Transport and instance identity come from the host adapter, never from harness ids. */
export function createHarnessDataClient(instanceId: string, send: (request: PluginRequestV1) => Promise<PluginResponseV1>) {
  let sequence = 0;
  async function request<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const requestId = `harness-data-${++sequence}`;
    const response = await send({ version: 1, instanceId, requestId, method, payload: { version: 1, ...payload } });
    if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
    if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
    return response.result as T;
  }
  return {
    list: () => request<HarnessListV1>("harnesses.list", {}),
    sessions: (harnessId: string, windowDays: 7 | 30 | 90 | 366, revision: number) =>
      request<HarnessSessionsV1>("harnesses.sessions", { harness_id: harnessId, windowDays, data_revision: revision }),
    async snapshot(windowDays: 7 | 30 | 90 | 366) {
      // An invalidation/resume consumer calls this again. Retry a concurrent
      // authority change, never mix statistics from different list revisions.
      for (let attempt = 0; attempt < 3; attempt++) {
        const list = await request<HarnessListV1>("harnesses.list", {});
        try {
          const data = await Promise.all(list.harnesses.filter((h) => h.capabilities.session_statistics.available)
            .map((h) => request<HarnessSessionsV1>("harnesses.sessions", { harness_id: h.id, windowDays, data_revision: list.data_revision })));
          if (data.some((d) => d.data_revision !== list.data_revision)) throw new Error("revision_changed");
          return { list, data };
        } catch (reason) {
          if (!(reason instanceof Error) || reason.message !== "revision_changed") throw reason;
        }
      }
      throw new Error("revision_changed");
    },
  };
}
