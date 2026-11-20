import { invokeHost } from "../../host";
import type { CityTemporalSnapshotV1 } from "@oh-agent/city-sdk/contracts";
import type { StoryEventRuleV1 } from "../../../../../../packages/city-game-sdk/src/api/v2";

type PluginResponse<T> = { version: number; requestId: string; ok: boolean; result?: T; error?: { code: string } };
export type CityGameRunHandleV1 = Readonly<{ runId: string; cityId: string; gameId: string; playerScope: Readonly<{ playerId: string; kind: "local-profile" | "preview" }>; status: "active" }>;
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

export type CityCodePreviewEnvelopeV1 = Readonly<{
  requestId: string;
  previewId: string;
  buildId: string;
  seed: number;
  source: Readonly<{ cityId: string; cityRevision?: number; synthetic?: boolean }>;
  manifest: unknown;
  snapshotId: string;
}>;

export type CityCodePreviewControlV1 = Readonly<{ control: "stop"; previewId: string; buildId: string; runId: string }>;

export async function takeCityCodePreview(): Promise<CityCodePreviewEnvelopeV1 | CityCodePreviewControlV1 | null> {
  if (!desktopAvailable()) return null;
  return hostCall("city.code.preview.next", {});
}

export async function readCityCodePreviewBytes(snapshotId: string, path: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (let count = 0; count < 64; count += 1) {
    const chunk = await hostCall<Readonly<{ contentBase64: string; byteLength: number; nextOffset: number; complete: boolean }>>(
      "city.code.preview.read", { snapshotId, path, offset },
    );
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.contentBase64) || chunk.contentBase64.length % 4 !== 0 || chunk.nextOffset <= offset && !chunk.complete) {
      throw new Error("game_package_integrity_failed");
    }
    const bytes = Uint8Array.from(atob(chunk.contentBase64), (character) => character.charCodeAt(0));
    chunks.push(bytes);
    offset = chunk.nextOffset;
    if (chunk.complete) {
      const result = new Uint8Array(chunk.byteLength);
      let cursor = 0;
      for (const part of chunks) { result.set(part, cursor); cursor += part.length; }
      if (cursor !== result.length) throw new Error("game_package_integrity_failed");
      return result;
    }
  }
  throw new Error("game_package_integrity_failed");
}

export async function closeCityCodePreview(snapshotId: string): Promise<void> {
  await hostCall("city.code.preview.close", { snapshotId });
}

export async function startCityGameRun(input: Readonly<{ cityId: string; gameId: string; buildId?: string }>): Promise<CityGameRunHandleV1 | null> {
  if (!desktopAvailable()) return null;
  return hostCall("city.game.run.start", {
    cityId: input.cityId, gameId: input.gameId,
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

export async function scheduleCityStory(runId: string, rule: StoryEventRuleV1, options: Readonly<{
  expectedStoryRevision: string;
  expectedClockRevision: string;
  operationId: string;
}>): Promise<Readonly<{ ruleId: string; storyRevision: string; nextDueUtcMs?: number }>> {
  return hostCall("city.story.schedule", { runId, rule, options });
}

export async function cancelCityStory(runId: string, ruleId: string, options: Readonly<{
  expectedStoryRevision: string;
  operationId: string;
}>): Promise<void> {
  await hostCall("city.story.cancel", { runId, ruleId, options });
}

export async function listCityStory(runId: string): Promise<readonly Readonly<{ ruleId: string; nextDueUtcMs?: number }>[]> {
  const result = await hostCall<Readonly<{ rules: readonly Readonly<{ ruleId: string; nextDueUtcMs?: number }>[] }>>("city.story.list", { runId });
  return result.rules;
}
