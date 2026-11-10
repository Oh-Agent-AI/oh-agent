/** Transport envelope only. Application adapters validate message bodies. */
export type RemoteScope = { appId: string; sessionId: string; capability: string };
export const REMOTE_PROTOCOL = "app-remote:v1";

export function remoteRequest(scope: RemoteScope, requestId: string, method: string, payload: object) {
  return { protocol: REMOTE_PROTOCOL, ...scope, type: "request", requestId, method, payload };
}

export function parseRemoteEnvelope(data: unknown, scope: RemoteScope, maxBytes: number): Record<string, unknown> | null {
  if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > maxBytes) return null;
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const envelope = value as Record<string, unknown>;
    return envelope.protocol === REMOTE_PROTOCOL && envelope.appId === scope.appId
      && envelope.sessionId === scope.sessionId && envelope.capability === scope.capability ? envelope : null;
  } catch { return null; }
}
