import { invokeHost } from "../../host";
import type { CityTemporalSnapshotV1 } from "@oh-agent/city-sdk/contracts";
import type { StoryEventRuleV1 } from "../../../../../../packages/city-game-sdk/src/api/v2";

type PluginResponse<T> = { version: number; requestId: string; ok: boolean; result?: T; error?: { code: string } };
export type CityGameRunHandleV1 = Readonly<{ runId: string; cityId: string; gameId: string; storyId?: string; storyRunId?: string; playerScope: Readonly<{ playerId: string; kind: "local-profile" | "preview" }>; status: "active" }>;
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

/// PR08 自动化试玩的宿主→webview 控制信封：与 stop control 同一条 pull 通道
/// （city.code.preview.next 轮询），宿主已做白名单/预算校验，这里只做防御性
/// 形状复核后再应用到本窗口自己的 game host（焦点隔离：主 City 窗口收不到）。
export type PlaytestInputControlV1 = Readonly<{ control: "playtest.input"; previewId: string; sessionId: string; seq: number; actions: Readonly<Record<string, number | boolean>>; holdMs: number }>;
export type PlaytestCaptureControlV1 = Readonly<{ control: "playtest.capture"; previewId: string; captureId: string }>;
export type PlaytestEndControlV1 = Readonly<{ control: "playtest.end"; previewId: string; sessionId: string; reason: string }>;

export async function takeCityCodePreview(): Promise<CityCodePreviewEnvelopeV1 | CityCodePreviewControlV1 | PlaytestInputControlV1 | PlaytestCaptureControlV1 | PlaytestEndControlV1 | null> {
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

export async function startCityGameRun(input: Readonly<{ cityId: string; gameId: string; buildId?: string; storyRunId?: string }>): Promise<CityGameRunHandleV1 | null> {
  if (!desktopAvailable()) return null;
  return hostCall("city.game.run.start", {
    cityId: input.cityId, gameId: input.gameId,
    ...(input.buildId ? { buildId: input.buildId } : {}),
    ...(input.storyRunId ? { storyRunId: input.storyRunId } : {}),
  });
}

export async function stopCityGameRun(runId: string): Promise<void> {
  if (desktopAvailable()) await hostCall("city.game.run.stop", { runId });
}

export async function readCityTime(cityId: string): Promise<CityTemporalSnapshotV1 | null> {
  if (!desktopAvailable()) return null;
  return hostCall("city.time.read", { cityId });
}

export type PreparedCityStory = Readonly<{
  storyRunId: string; storyId: string; cityId: string; cityName: string; title: string; storyVersion: string;
}>;

export type CityStoryRunView = Readonly<{
  storyRunId: string; storyRevision: string;
  dialogue: readonly Readonly<{ eventId: string; intent: { text?: string; edgeId?: string }; replyToEventId: string | null }>[];
  presentation: Readonly<{
    beat: Readonly<{ title?: string; kind: string }> | null;
    characters: readonly Readonly<{ id: string; name: string }>[];
  }> | null;
}>;

export async function listPreparedCityStories(): Promise<readonly PreparedCityStory[]> {
  const result = await hostCall<Readonly<{ runs: readonly PreparedCityStory[] }>>("city.story.prepared.list", {});
  return result.runs;
}

export type CityStoryCompletionAction = "finish" | "restart";

export function completeCityStory(runId: string, action: CityStoryCompletionAction): Promise<Readonly<{
  action: CityStoryCompletionAction; runId: string; storyRunId: string;
}>> {
  return hostCall("city.story.playtest.complete", { runId, action });
}

export function readCityStoryRun(runId: string): Promise<CityStoryRunView> {
  return hostCall("city.story.run.read", { runId });
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
