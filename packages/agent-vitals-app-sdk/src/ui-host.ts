export type Tool = { id: string; commandId: string; label: string; kind: "button" | "select"; enabled: boolean; placement?: "primary" | "overflow"; value?: string; options?: Array<{ value: string; label: string }> };
export type Command = { version: number; instanceId: string; requestId: string; commandId: string; value?: string };
declare global { interface Window {
  __AV_PLUGIN_INSTANCE__?: string;
  __AV_PLUGIN_LOCALE__?: "en" | "zh-Hans";
  __TAURI__?: { core?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>; }; };
} }
// Browser preview uses the same DTOs over postMessage; never shares parent stores/DOM.
const browserInstance = window.parent !== window && !window.__TAURI__?.core?.invoke
  ? new URL(location.href).searchParams.get("instanceId") : null;
if (browserInstance) window.__AV_PLUGIN_INSTANCE__ = browserInstance;
// Unspecified locale follows the system language; unsupported systems (ja, ko, …) fall back to English.
const systemLocale = (): "en" | "zh-Hans" =>
  typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh-Hans" : "en";
if (browserInstance) {
  const requested = new URL(location.href).searchParams.get("locale");
  window.__AV_PLUGIN_LOCALE__ = requested === "zh-Hans" || requested === "en" ? requested : systemLocale();
}
export const pluginLocale = () => window.__AV_PLUGIN_LOCALE__ ?? systemLocale();
export function observeLocale(callback: () => void) {
  window.addEventListener("__AV_PLUGIN_LOCALE_CHANGED__", callback);
  return () => window.removeEventListener("__AV_PLUGIN_LOCALE_CHANGED__", callback);
}
let sequence = 0;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: number }>();
if (browserInstance) window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== window.parent || event.origin !== location.origin
    || message?.channel !== "av-plugin-rpc" || message.version !== 1 || message.instanceId !== browserInstance) return;
  if (message.type === "response") {
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId); window.clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
  } else if (message.type === "command") {
    window.dispatchEvent(new CustomEvent("__AV_PLUGIN_COMMAND__", { detail: message.command }));
  } else if (message.type === "invalidate") window.dispatchEvent(new Event("__AV_PLUGIN_INVALIDATED__"));
  else if (message.type === "suspend") window.dispatchEvent(new Event("__AV_PLUGIN_SUSPENDED__"));
  else if (message.type === "resume") window.dispatchEvent(new Event("__AV_PLUGIN_RESUMED__"));
  else if (message.type === "locale" && ["en", "zh-Hans"].includes(message.locale)) {
    window.__AV_PLUGIN_LOCALE__ = message.locale;
    window.dispatchEvent(new Event("__AV_PLUGIN_LOCALE_CHANGED__"));
  }
});
export async function invokeHost<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!browserInstance) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error("plugin_backend_unavailable");
    return invoke<T>(command, args);
  }
  const requestId = `rpc-${++sequence}`;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => { pending.delete(requestId); reject(new Error("preview_request_timeout")); }, 10000);
    pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
    window.parent.postMessage({ channel: "av-plugin-rpc", version: 1, instanceId: browserInstance, type: "request", requestId, command, args }, location.origin);
  });
}
let revision = 0;
export const embedded = () => !!window.__AV_PLUGIN_INSTANCE__;
export async function publish(type: string, payload: Record<string, unknown> = {}) {
  if (!embedded()) return;
  await invokeHost("plugin_message", { message: { version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, type, ...payload } });
}
export function publishToolbar(items: Tool[]) { void publish("toolbar.update", { revision: ++revision, items }).catch(() => {}); }
export function connect(handler: (command: Command) => void) {
  const receive = (event: Event) => {
    const command = (event as CustomEvent<Command>).detail;
    if (command?.version !== 1 || command.instanceId !== window.__AV_PLUGIN_INSTANCE__) return;
    let ok = true;
    try { handler(command); } catch { ok = false; }
    void publish("command.result", { requestId: command.requestId, ok }).catch(() => {});
  };
  window.addEventListener("__AV_PLUGIN_COMMAND__", receive);
  return () => window.removeEventListener("__AV_PLUGIN_COMMAND__", receive);
}
/** Tell the host a sync stretch is about to run so the 5s pulse is not a hang.
 * `budgetMs` is capped at 15s — the same boot-timeout ceiling. Await this before
 * the blocking work; a fire-and-forget publish can lose the race. */
export async function noteBusy(budgetMs = 8_000) {
  const busyMs = Math.max(1, Math.min(Math.floor(budgetMs), 15_000));
  await publish("heartbeat", { diagnostic: { busyMs } });
}
export function observeHealth(state?: () => Record<string, number | boolean>) {
  const fault = (event: Event) => {
    // Chromium reports a deferred ResizeObserver delivery as a window error.
    // It is a non-fatal layout diagnostic, not an uncaught plugin exception;
    // treating it as a crash would tear down otherwise healthy embedded views.
    if (event instanceof ErrorEvent && [
      "ResizeObserver loop completed with undelivered notifications.",
      "ResizeObserver loop limit exceeded",
    ].includes(event.message)) return;
    void publish("runtime.error").catch(() => {});
  };
  let pulses = 0;
  const timer = window.setInterval(() => {
    void publish("heartbeat", ++pulses % 4 === 0 ? { diagnostic: {
      hidden: document.visibilityState === "hidden", focused: document.hasFocus(), ...state?.(),
    } } : {}).catch(() => {});
  }, 500);
  window.addEventListener("error", fault); window.addEventListener("unhandledrejection", fault);
  return () => { window.clearInterval(timer); window.removeEventListener("error", fault); window.removeEventListener("unhandledrejection", fault); };
}
