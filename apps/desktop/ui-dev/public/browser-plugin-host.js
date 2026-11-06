// Local browser preview only. Not loaded by the native app, no real-user data.
(() => {
  if (window.parent !== window || window.__TAURI_INTERNALS__ || !window.__TAURI__?.core?.invoke) return;
  const invoke = window.__TAURI__.core.invoke;
  const definitions = () => window.__AV_PLUGIN_REGISTRY__?.plugins ?? [];
  let generation = 0, sequence = 0, current = null, frame = null;
  const notify = () => window.dispatchEvent(new Event("__AV_PLUGIN_STATUS__"));
  const note = (code, requestId) => {
    current?.events.push({ atMs: Date.now() - current.started, code, requestId });
    if (current?.events.length > 100) current.events.shift();
  };
  const fail = (code) => {
    if (!current || current.status === "failed") return;
    current.status = "failed"; current.error = code; note(code); notify();
  };
  const send = (type, payload = {}) => frame?.contentWindow?.postMessage({
    channel: "av-plugin-rpc", version: 1, instanceId: current?.instanceId, type, ...payload,
  }, location.origin);
  const pluginMessage = (message) => {
    if (!current || message.version !== 1 || message.instanceId !== current.instanceId) throw new Error("stale_instance");
    if (current.status === "failed") throw new Error("plugin_failed");
    if (message.type === "toolbar.update") {
      if (!Number.isSafeInteger(message.revision) || message.revision <= current.revision) throw new Error("stale_revision");
      const text = (value, limit, nonempty = false) => typeof value === "string" && value.length <= limit && (!nonempty || value.length > 0);
      if (!Array.isArray(message.items) || message.items.length > 9 || message.items.some((item) =>
        !item || !text(item.id, 64, true) || !text(item.label, 100, true) || typeof item.enabled !== "boolean"
        || !text(item.commandId, 64, true) || !item.commandId.startsWith(`${current.commandNamespace}.`) || !["button", "select"].includes(item.kind)
        || (item.kind === "select" && (!Array.isArray(item.options) || item.options.length < 1 || item.options.length > 8
          || item.options.some((option) => !option || !text(option.value, 32) || !text(option.label, 100))
          || !item.options.some((option) => option.value === item.value))))
        || new Set(message.items.map((item) => item.id)).size !== message.items.length) throw new Error("invalid_tools");
      current.items = message.items; current.revision = message.revision; current.status = "ready";
      note("toolbar_updated"); notify();
    } else if (message.type === "heartbeat") current.pulse = Date.now();
    else if (message.type === "runtime.error") fail("plugin_runtime_error");
    else if (message.type === "command.result") {
      if (message.requestId !== current.pending) throw new Error("stale_request");
      note("command_result", message.requestId); current.pending = null;
      if (!message.ok) fail("plugin_command_rejected"); else notify();
    } else throw new Error("invalid_message");
  };
  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (event.origin !== location.origin || event.source !== frame?.contentWindow
      || message?.channel !== "av-plugin-rpc" || message.version !== 1 || message.type !== "request") return;
    const target = event.source, instanceId = message.instanceId;
    let result = null, error = null;
    try {
      if (!current || instanceId !== current.instanceId) throw new Error("stale_instance");
      if (message.command === "plugin_message") pluginMessage(message.args.message);
      else if (message.command === "plugin_request") {
        if (current.status === "failed") throw new Error("plugin_failed");
        note("plugin_request_received");
        const request = message.args.request;
        if (!request || request.version !== 1 || request.instanceId !== instanceId || typeof request.requestId !== "string"
          || typeof request.method !== "string" || !request.payload || typeof request.payload !== "object") throw new Error("invalid_plugin_request");
        const provider = window.__AV_BROWSER_PROVIDERS__?.[current.pluginId];
        if (provider) {
          const data = await provider(request);
          result = { version: 1, requestId: request.requestId, ok: true, result: data, error: null };
        } else {
          result = { version: 1, requestId: request.requestId, ok: false, result: null, error: { code: "provider_unavailable", retryable: true } };
        }
        if (current?.instanceId !== instanceId || current.status === "failed") throw new Error("stale_instance");
      } else throw new Error("plugin_command_unavailable");
    } catch { error = "preview_request_rejected"; }
    target.postMessage({ channel: "av-plugin-rpc", version: 1, instanceId, type: "response", requestId: message.requestId, result, error }, event.origin);
  });
  window.__TAURI__.core.invoke = async (command, args = {}) => {
    if (!command.startsWith("plugin_")) return invoke(command, args);
    if (command === "plugin_open") {
      const definition = definitions().find((plugin) => plugin.id === args.pluginId);
      if (!definition) throw new Error("plugin_unknown");
      const bounds = args.bounds;
      if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error("invalid_bounds");
      if (args.restart) {
        frame?.remove();
        current = { pluginId: definition.id, commandNamespace: definition.commandNamespace, instanceId: `browser-plugin-${definition.id}-${++generation}`, status: "loading", error: null, items: [], revision: 0, pending: null, events: [], started: Date.now(), pulse: Date.now() };
        frame = document.createElement("iframe"); frame.title = `${definition.name} 浏览器预览`;
        frame.dataset.pluginId = definition.id;
        frame.src = `/${definition.entry}?instanceId=${current.instanceId}&locale=${args.locale === "zh-Hans" ? "zh-Hans" : "en"}`;
        frame.style.cssText = "position:fixed;border:0;z-index:10";
        document.body.append(frame); note("instance_created");
      } else if (!current || (args.instanceId && args.instanceId !== current.instanceId) || args.pluginId !== current.pluginId) throw new Error("stale_instance");
      if (current.suspended) {
        current.suspended = false; current.started = Date.now(); current.pulse = Date.now();
        frame.style.display = "";
        send("resume"); note("resumed");
      }
      Object.assign(frame.style, { left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
      current.boundsSeq = 0;
      send("locale", { locale: args.locale === "zh-Hans" ? "zh-Hans" : "en" });
      return current.instanceId;
    }
    if (command === "plugin_close") {
      if (args.suspend && args.instanceId === current?.instanceId && current.status !== "failed") {
        current.suspended = true; current.pending = null;
        send("suspend");
        frame.style.display = "none"; note("suspended"); return;
      }
      if (args.instanceId === current?.instanceId) { frame?.remove(); frame = null; current = null; }
      return;
    }
    if (command === "plugin_snapshot") return current ? structuredClone(current) : null;
    if (command === "plugin_set_bounds") {
      if (!current || args.instanceId !== current.instanceId || current.status === "failed") throw new Error("plugin_unavailable");
      const bounds = args.bounds;
      if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
        || bounds.width <= 0 || bounds.height <= 0 || !Number.isSafeInteger(args.seq) || args.seq < 1) throw new Error("invalid_bounds");
      if (args.seq <= current.boundsSeq) return;
      current.boundsSeq = args.seq;
      Object.assign(frame.style, { left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
      return;
    }
    if (!current || args.instanceId !== current.instanceId || current.status !== "ready") throw new Error("plugin_unavailable");
    if (command === "plugin_invalidate") { send("invalidate"); return; }
    if (command === "plugin_command") {
      const tool = current.items.find((item) => item.commandId === args.commandId);
      if (!tool?.enabled || current.pending || (tool.kind === "select" && !tool.options?.some((option) => option.value === args.value))) throw new Error("plugin_command_rejected");
      const requestId = `request-${++sequence}`;
      current.pending = requestId; current.pendingAt = Date.now(); note("command_sent", requestId);
      send("command", { command: { version: 1, instanceId: current.instanceId, requestId, commandId: args.commandId, value: args.value } });
      return requestId;
    }
    throw new Error("plugin_command_unavailable");
  };
  // Browser timers are not independent of a frozen iframe. Never inject hangs here.
  window.setInterval(() => {
    if (!current || current.suspended || current.status === "failed") return;
    if (current.status === "loading" && Date.now() - current.started > 15000) fail("plugin_boot_timeout");
    // No renderer-liveness guarantee here: software WebGL can delay both pages.
    // Native Rust watchdogs, not browser timers, validate hang isolation.
    else if (current.pending && Date.now() - current.pendingAt > 30000) fail("plugin_command_timeout");
  }, 500);
})();
