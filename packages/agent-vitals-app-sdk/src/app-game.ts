import { invokeHost, pluginLocale, publish } from "./ui-host.js";
import type {
  PluginRequestV1,
  PluginResponseV1,
  PluginStateReadResult,
  PluginStateWritePayload,
  PluginStateWriteResult,
} from "./plugin-rpc.js";

export type Dispose = () => void;

export interface AppGameHooks {
  start(): void | Promise<void>;
  suspend(): void;
  resume(): void;
  dispose(): void;
}

export interface AppHostClient {
  locale(): string;
  state: {
    read(key: string): Promise<PluginStateReadResult>;
    write(input: PluginStateWritePayload): Promise<PluginStateWriteResult>;
  };
  onSuspend(callback: () => void): Dispose;
  onResume(callback: () => void): Dispose;
}

let requestSequence = 0;
let readyRevision = 0;
const stateKeyPattern = /^[a-z0-9-]+:v[0-9]+$/;
const MAX_STATE_BYTES = 48 * 1024;

function fail(code: string): never { throw new Error(code); }

function validRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertJsonValue(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 64) fail("invalid_state_value");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value)) fail("invalid_state_value");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen, depth + 1);
  } else {
    if (!validRecord(value)) fail("invalid_state_value");
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) fail("invalid_state_value");
      assertJsonValue(item, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function assertStateKey(key: string): void {
  if (typeof key !== "string" || key.length > 64 || !stateKeyPattern.test(key)) fail("invalid_state_key");
}

async function stateRequest<TResult>(method: string, payload: Record<string, unknown>): Promise<TResult> {
  const instanceId = window.__AV_PLUGIN_INSTANCE__;
  if (!instanceId) fail("plugin_instance_unavailable");
  const requestId = `app-sdk-${++requestSequence}`;
  const request: PluginRequestV1 = { version: 1, instanceId, requestId, method, payload };
  const response = await invokeHost<PluginResponseV1<TResult>>("plugin_request", { request });
  if (!response || response.version !== 1 || response.requestId !== requestId || typeof response.ok !== "boolean") {
    fail("plugin_response_invalid");
  }
  if (!response.ok) {
    const code = response.error?.code;
    fail(typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "plugin_request_failed");
  }
  if (response.error !== null || response.result === null || typeof response.result !== "object" || Array.isArray(response.result)) {
    fail("plugin_response_invalid");
  }
  return response.result;
}

function validateReadResult(value: unknown): PluginStateReadResult {
  if (!validRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !(value.value === null || validRecord(value.value))) fail("plugin_response_invalid");
  if (value.value !== null) assertJsonValue(value.value);
  return value as unknown as PluginStateReadResult;
}

function validateWriteResult(value: unknown, expectedRevision: number): PluginStateWriteResult {
  if (!validRecord(value) || !Number.isSafeInteger(value.revision) || value.revision !== expectedRevision + 1) {
    fail("plugin_response_invalid");
  }
  return value as unknown as PluginStateWriteResult;
}

export function createAppHostClient(): AppHostClient {
  return {
    locale: () => pluginLocale(),
    state: {
      async read(key) {
        assertStateKey(key);
        return validateReadResult(await stateRequest<unknown>("plugin.state.read", { key }));
      },
      async write(input) {
        if (!validRecord(input)) fail("invalid_state_value");
        assertStateKey(input.key as string);
        if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0 || !validRecord(input.value)) {
          fail("invalid_state_value");
        }
        assertJsonValue(input.value);
        const expectedRevision = input.revision as number;
        if (new TextEncoder().encode(JSON.stringify({ revision: expectedRevision + 1, value: input.value })).byteLength > MAX_STATE_BYTES) {
          fail("state_too_large");
        }
        const result = await stateRequest<unknown>("plugin.state.write", {
          key: input.key,
          revision: expectedRevision,
          value: input.value,
        });
        return validateWriteResult(result, expectedRevision);
      },
    },
    onSuspend: (callback) => observe("__AV_PLUGIN_SUSPENDED__", callback),
    onResume: (callback) => observe("__AV_PLUGIN_RESUMED__", callback),
  };
}

function observe(eventName: string, callback: () => void): Dispose {
  window.addEventListener(eventName, callback);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener(eventName, callback);
  };
}

/**
 * Starts an app game and reports an empty toolbar only after initialization succeeds.
 * The returned disposer is safe to call repeatedly; pagehide invokes it automatically.
 */
export async function connectAppGame(hooks: AppGameHooks): Promise<Dispose> {
  let disposed = false;
  let startInvoked = false;
  let suspended = false;
  let cleanupPromise: Promise<void> | undefined;
  const disposeListeners: Dispose[] = [];

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    disposed = true;
    for (const remove of disposeListeners.splice(0)) remove();
    cleanupPromise = Promise.resolve().then(() => {
      if (!startInvoked) return;
      startInvoked = false;
      try { hooks.dispose(); } catch { /* cleanup remains idempotent and best effort */ }
    });
    return cleanupPromise;
  };

  const reportRuntimeError = async () => {
    try { await publish("runtime.error"); } catch { /* best effort host notification */ }
  };

  const lifecycleFault = async () => {
    await reportRuntimeError();
    await cleanup();
  };

  const suspend = () => {
    if (disposed || suspended) return;
    suspended = true;
    try { hooks.suspend(); } catch { void lifecycleFault(); }
  };
  const resume = () => {
    if (disposed || !suspended) return;
    suspended = false;
    try { hooks.resume(); } catch { void lifecycleFault(); }
  };
  const pagehide = () => { void cleanup(); };
  disposeListeners.push(observe("__AV_PLUGIN_SUSPENDED__", suspend));
  disposeListeners.push(observe("__AV_PLUGIN_RESUMED__", resume));
  disposeListeners.push(observe("pagehide", pagehide));

  try {
    startInvoked = true;
    await hooks.start();
    if (disposed) fail("app_game_disposed_during_start");
    await publish("toolbar.update", { revision: ++readyRevision, items: [] });
    return () => { void cleanup(); };
  } catch (error) {
    await reportRuntimeError();
    await cleanup();
    throw error;
  }
}
