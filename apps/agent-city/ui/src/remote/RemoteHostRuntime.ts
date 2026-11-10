import { RemoteHostAdapterRegistry, resolveRemoteHostAdapter, type RemoteHostAdapter, type RemoteHostAdapterFactory, type RemoteHostContext, type RemoteHostRequest } from "./RemoteHostAdapterRegistry";

type HostReplyPayload = { type: "ready" } | { type: "created" }
  | { type: "joined"; ok: boolean } | { type: "frozen"; snapshot: unknown }
  | { type: "message"; message: unknown };
type HostReply = HostReplyPayload & { token: string };

declare global {
  interface Window {
    __AV_REMOTE_HOST_CONTEXT__?: RemoteHostContext;
    __TAURI__?: { core?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } };
  }
}

function validContext(value: unknown): value is RemoteHostContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Partial<RemoteHostContext>;
  return typeof context.appId === "string" && /^[A-Za-z0-9:_-]{1,80}$/.test(context.appId)
    && typeof context.capability === "string" && /^[A-Za-z0-9:_-]{1,80}$/.test(context.capability)
    && typeof context.sessionId === "string" && /^[A-Za-z0-9:_-]{1,80}$/.test(context.sessionId)
    && typeof context.token === "string" && /^[a-f0-9]{64}$/.test(context.token);
}

/** Boots exactly one trusted adapter for the native host's immutable scope. */
export function startRemoteHostRuntime(factories: readonly RemoteHostAdapterFactory[]) {
  const context = window.__AV_REMOTE_HOST_CONTEXT__;
  const invoke = window.__TAURI__?.core?.invoke;
  if (!validContext(context) || !invoke) {
    document.body.textContent = "Remote game host requires an authorized desktop session.";
    return () => {};
  }
  const factory = resolveRemoteHostAdapter(context, factories);
  if (!factory) {
    document.body.textContent = "Remote game capability is unavailable.";
    return () => {};
  }

  let closed = false;
  let ready = false;
  const controller = new AbortController();
  const emit = (reply: HostReplyPayload) => {
    if (closed) return;
    void invoke("remote_host_message", { reply: { ...reply, token: context.token } as HostReply }).catch(() => {});
  };
  const registry = new RemoteHostAdapterRegistry();
  registry.pause();
  let adapter: RemoteHostAdapter;
  let unregister: (() => void) | null = null;
  try {
    adapter = factory.create(context, {
      signal: controller.signal,
      send: message => { if (ready) emit({ type: "message", message }); },
      lifecycle: reply => { if (ready) emit(reply); },
    });
    if (adapter.appId !== context.appId || adapter.capability !== context.capability) throw new Error("remote_host_adapter_scope_mismatch");
    const onError = adapter.onError?.bind(adapter) ?? ((request: RemoteHostRequest["request"], code: "unavailable" | "backpressure") => {
      if (ready) emit({ type: "message", message: { type: "response", requestId: request.requestId,
        result: { ok: false, error: { code } } } });
    });
    const registeredAdapter: RemoteHostAdapter = {
      appId: adapter.appId, capability: adapter.capability,
      handle: request => adapter.handle(request),
      start: adapter.start?.bind(adapter), onError,
      close: adapter.close?.bind(adapter),
    };
    unregister = registry.register(registeredAdapter);
  } catch {
    document.body.textContent = "Remote game host could not be initialized.";
    return () => {};
  }

  const listener = (event: Event) => { registry.dispatch((event as CustomEvent<unknown>).detail, context); };
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener("__AV_REMOTE_HOST_REQUEST__", listener);
    window.removeEventListener("pagehide", close);
    registry.close();
    controller.abort();
    unregister?.();
    try { adapter.close?.(); } catch { /* shutdown must remain idempotent */ }
  };
  window.addEventListener("pagehide", close, { once: true });
  window.addEventListener("__AV_REMOTE_HOST_REQUEST__", listener);
  const activate = () => {
    if (closed) return;
    ready = true;
    registry.resume();
    emit({ type: "ready" });
  };
  try {
    const started = adapter.start?.(controller.signal);
    if (started && typeof (started as Promise<void>).then === "function") {
      void Promise.resolve(started).then(activate).catch(() => {
        if (!closed) {
          close();
          document.body.textContent = "Remote game host could not be initialized.";
        }
      });
    } else activate();
  } catch {
    close();
    document.body.textContent = "Remote game host could not be initialized.";
  }
  return close;
}
