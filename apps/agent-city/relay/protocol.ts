export const PROTOCOL = "app-remote:v1";
export const MAX_MESSAGE_BYTES = 256 * 1024;
export type Role = "host" | "owner" | "guest";
export type Peer = { id: string; role: Role; playerId: string };

export type Capability = { id: string; methods: string[]; events: string[] };
export type Scope = { appId: string; sessionId: string; capability: Capability };
export type RoomRecord = Scope & { ownerHash: string; createdAt: number; hostLeaseExpiresAt?: number };
export type AccessRecord = {
  id: string;
  role: Role;
  playerId: string;
  secretHash: string;
  approved: boolean;
  expiresAt: number;
  inviteHash?: string;
  inviteId?: string;
  joined?: boolean;
};
export type TicketRecord = { peer: Peer; expiresAt: number };

export function id(value: unknown, max = 80): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9:_-]+$/.test(value);
}

export function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function secretHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function error(code: string, status = 400): Response {
  return Response.json({ ok: false, error: { code } }, { status, headers: { "Cache-Control": "no-store" } });
}

export function bearer(request: Request): string | null {
  const value = request.headers.get("Authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

export async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > 8192) return null;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 8192) return null;
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function response(scope: Scope, requestId: string, result: unknown): string {
  return JSON.stringify({ protocol: PROTOCOL, appId: scope.appId, sessionId: scope.sessionId, capability: scope.capability.id, type: "response", requestId, result });
}

export function failure(code: string): { ok: false; error: { code: string } } {
  return { ok: false, error: { code } };
}

const name = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 80 && /^[A-Za-z0-9:_.-]+$/.test(value);
export function parseCapability(value: unknown): Capability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cap = value as Record<string, unknown>;
  const list = (items: unknown, required: boolean): items is string[] => Array.isArray(items) && (!required || items.length > 0)
    && items.length <= 32 && items.every(name) && new Set(items).size === items.length;
  return name(cap.id) && list(cap.methods, true) && list(cap.events, false) ? { id: cap.id, methods: cap.methods, events: cap.events } : null;
}

function inScope(value: Record<string, unknown>, scope: Scope): boolean {
  return value.protocol === PROTOCOL && value.appId === scope.appId && value.sessionId === scope.sessionId && value.capability === scope.capability.id;
}

export function requestPeer(message: unknown, scope: Scope): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "invalid_message";
  const value = message as Record<string, unknown>;
  if (!inScope(value, scope)) return "forbidden";
  if (value.type !== "request" || !id(value.requestId) || typeof value.method !== "string" || !scope.capability.methods.includes(value.method)) return "invalid_message";
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) return "invalid_message";
  return null;
}

export function hostMessage(message: unknown, scope: Scope): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const value = message as Record<string, unknown>;
  if (!inScope(value, scope)) return false;
  if (value.type === "response") return id(value.requestId);
  if (value.type !== "event") return false;
  const event = value.event as Record<string, unknown> | null;
  return Boolean(event && typeof event.type === "string" && scope.capability.events.includes(event.type));
}
