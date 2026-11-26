import { invokeHost } from "@agent-vitals/app-sdk/ui-host";
import { errorCode } from "./creatorHostUtils";

export type CreatorRequest = <T>(method: string, payload: Record<string, unknown>) => Promise<T>;

type PluginResponse<T> = { version: number; requestId: string; ok: boolean; result?: T; error?: { code: string } };
let sequence = 0;

// 浏览器预览（ui-dev 工作台 iframe）：有插件实例但没有原生宿主，数据来自合成夹具。
export const browserPreview = typeof window !== "undefined" && window.parent !== window
  && !(window as Window & { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core?.invoke;

export async function creatorRequest<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const instanceId = (window as Window & { __AV_PLUGIN_INSTANCE__?: string }).__AV_PLUGIN_INSTANCE__;
  if (!instanceId) throw new Error("creator_studio_not_running_in_host");
  const requestId = `creator-ui:${++sequence}`;
  let response: PluginResponse<T>;
  try { response = await invokeHost<PluginResponse<T>>("plugin_request", { request: { version: 1, instanceId, requestId, method, payload } }); }
  catch (error) { throw new Error(errorCode(error, "creator_request_failed")); }
  if (response.version !== 1 || response.requestId !== requestId) throw new Error("creator_response_invalid");
  if (!response.ok || response.result === undefined) throw new Error(response.error?.code ?? "creator_request_failed");
  return response.result;
}
