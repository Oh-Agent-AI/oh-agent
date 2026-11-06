/** Generic host ↔ app-plugin request envelope. Domain payloads belong to the app. */
export interface PluginRequestV1<TPayload = Record<string, unknown>> {
  version: 1;
  instanceId: string;
  requestId: string;
  method: string;
  payload: TPayload;
}

export interface PluginResponseV1<TResult = unknown> {
  version: 1;
  requestId: string;
  ok: boolean;
  result: TResult | null;
  error: {
    code: string;
    retryable: boolean;
  } | null;
}

/**
 * 通用插件本地状态端口（CITY_GAME_MODE_IMPLEMENTATION_PLAN §9）：
 * 宿主提供有界 JSON 文档存储（应用私有目录 plugins/<registered-id>/state/，路径由宿主生成，
 * 单文档 ≤ 32 KiB，revision 乐观并发，原子替换）。key 须在插件描述表 stateKeys 中声明。
 * 原生错误码：state_key_denied / invalid_state_key / invalid_state_value / revision_required /
 * revision_conflict / state_too_large / state_unavailable（后两者与 conflict 标记 retryable）。
 */
export interface PluginStateReadPayload { key: string }
export interface PluginStateReadResult { value: Record<string, unknown> | null; revision: number }
export interface PluginStateWritePayload { key: string; revision: number; value: Record<string, unknown> }
export interface PluginStateWriteResult { revision: number }
