import { invokeHost } from "../../host";
import type { CityTemporalSnapshotV1 } from "@oh-agent/city-sdk/contracts";

type PluginResponse<T> = { version: number; requestId: string; ok: boolean; result?: T; error?: { code: string } };
export type CityGameRunHandleV1 = Readonly<{ runId: string; cityId: string; gameId: string; status: "active" }>;
export type CityStoryReceiptV1 = Readonly<{ eventId: string; operationId: string; storyRevision: string; clockRevision: string; status: "committed" }>;

function desktopAvailable(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI__?.core?.invoke;
}

async function hostCall<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const requestId = `city-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await invokeHost<PluginResponse<T>>("plugin_request", {
    request: { version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId, method, payload },
  });
  if (!response.ok) throw new Error(response.error?.code ?? "city_runtime_unavailable");
  return response.result as T;
}

export async function startCityGameRun(input: Readonly<{ cityId: string; gameId: string; playerId: string; buildId?: string }>): Promise<CityGameRunHandleV1 | null> {
  if (!desktopAvailable()) return null;
  return hostCall("city.game.run.start", {
    cityId: input.cityId, gameId: input.gameId, playerId: input.playerId,
    ...(input.buildId ? { buildId: input.buildId } : {}),
  });
}

export async function stopCityGameRun(runId: string): Promise<void> {
  if (desktopAvailable()) await hostCall("city.game.run.stop", { runId });
}

export async function readCityTime(cityId: string): Promise<CityTemporalSnapshotV1 | null> {
  if (!desktopAvailable()) return null;
  return hostCall("city.time.read", { cityId });
}

export async function readCityStory(runId: string): Promise<Readonly<{ storyRevision: string; state: Record<string, unknown> }>> {
  return hostCall("city.story.read", { runId });
}

export async function commitCityStory(input: Readonly<{
  runId: string;
  operationId: string;
  eventId: string;
  residentId?: string;
  expectedStoryRevision: string;
  expectedClockRevision: string;
  intent: Readonly<Record<string, unknown>>;
}>): Promise<CityStoryReceiptV1> {
  return hostCall("city.story.commit", {
    runId: input.runId, operationId: input.operationId, eventId: input.eventId,
    ...(input.residentId ? { residentId: input.residentId } : {}),
    expectedStoryRevision: input.expectedStoryRevision, expectedClockRevision: input.expectedClockRevision,
    intent: input.intent,
  });
}
