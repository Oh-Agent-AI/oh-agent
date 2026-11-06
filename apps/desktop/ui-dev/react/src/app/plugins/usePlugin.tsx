import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, listenAppEvents } from "../../lib/tauri";
import { message, useLanguage } from "../../lib/i18n";
import { pluginCreationCode, pluginCreationHelp } from "./pluginDiagnostics";

type Tool = { id: string; commandId: string; label: string; kind: "button" | "select"; enabled: boolean; placement?: "primary" | "overflow"; value: string | null; options: Array<{ value: string; label: string }> };
type Snapshot = { pluginId: string; instanceId: string; status: "loading" | "ready" | "failed"; error: string | null; items: Tool[]; pending: string | null; events: Array<{ atMs: number; code: string }> };

export type PluginPresentation = { id: string; name: string };

/** Host-owned single-slot lifecycle/presentation; plugin names and tools are data.
 * The native adapter currently registers one official plugin, not a package registry.
 */
export function usePlugin(active: boolean, { id: pluginId, name }: PluginPresentation) {
  const slot = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const lifecycle = useRef<Promise<unknown>>(Promise.resolve());
  const opened = useRef({ pluginId: "", attempt: -1 });
  const locale = useLanguage();
  const localeRef = useRef(locale); localeRef.current = locale;
  const currentId = useRef<string | null>(null);
  const syncLayoutRef = useRef<(() => void) | null>(null);
  // React layout changes (including position-only changes) should not wait for
  // a ResizeObserver plus another animation frame before moving the native view.
  useLayoutEffect(() => { if (active) void syncLayoutRef.current?.(); });
  useEffect(() => {
    const rect = slot.current?.getBoundingClientRect();
    if (active && currentId.current && rect && rect.width > 0 && rect.height > 0) {
      void invoke("plugin_open", { pluginId, restart: false, instanceId: currentId.current,
        locale, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }).catch(() => {});
    }
  }, [locale]);
  useEffect(() => {
    // Retaining a ready snapshot prevents a suspended-then-resumed plugin from
    // flashing the host loading shell while plugin_open/plugin_snapshot return.
    if (!active) return;
    let cancelled = false;
    let id: string | null = null;
    let ticking = false;
    let observer: ResizeObserver | null = null;
    let layoutRunning = false;
    let layoutPending = false;
    let lastBounds = "";
    let unsubscribe = () => {};
    setSnapshot((current) => current?.pluginId === pluginId && current.status === "ready" ? current : null);
    setError(null); setBusy(false);
    const bounds = () => {
      const rect = slot.current?.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) throw new Error("slot_unavailable");
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const start = async () => {
      try {
        const initialBounds = bounds();
        await lifecycle.current.catch(() => {});
        if (cancelled) return;
        const restart = opened.current.pluginId !== pluginId || opened.current.attempt !== attempt;
        id = await invoke<string>("plugin_open", { pluginId, bounds: initialBounds, restart, locale: localeRef.current });
        currentId.current = id;
        opened.current = { pluginId, attempt };
        lastBounds = JSON.stringify(initialBounds);
        if (cancelled) { await invoke("plugin_close", { instanceId: id }); return; }
        // The inactive tab does not subscribe to authority invalidations.
        // Refresh the retained instance on resume without rebuilding its UI.
        if (!restart) await invoke("plugin_invalidate", { instanceId: id }).catch(() => {});
        if (cancelled) return;
        let layoutSeq = 0;
        let rafId = 0;
        // P1 §4.3: rAF-aligned latest-value override — new bounds overwrite the
        // pending value; only one IPC per animation frame. No await-chain stacking.
        const syncLayout = () => {
          if (cancelled || !id) return;
          if (rafId) return; // already scheduled for this frame
          rafId = requestAnimationFrame(async () => {
            rafId = 0;
            if (cancelled || !id) return;
            try {
              const next = bounds();
              const key = JSON.stringify(next);
              if (key === lastBounds) return;
              layoutSeq += 1;
              await invoke("plugin_set_bounds", { instanceId: id, bounds: next, seq: layoutSeq });
              lastBounds = key;
            } catch (reason) { if (!cancelled) {
              const code = pluginCreationCode(reason);
              setError(code === "plugin_create_failed" ? "plugin_layout_failed" : code);
            } }
          });
        };
        syncLayoutRef.current = syncLayout;
        observer = new ResizeObserver(() => { if (!cancelled && id) void syncLayout(); });
        if (slot.current) observer.observe(slot.current);
        void syncLayout();
      } catch (reason) {
        if (!cancelled) {
          opened.current = { pluginId: "", attempt: -1 };
          setError(pluginCreationCode(reason));
        }
      }
    };
    void start();
    void listenAppEvents((event) => {
      if (!cancelled && id && ["Invalidated", "SourceDataDeleted"].includes(event.type)) {
        void invoke("plugin_invalidate", { instanceId: id }).catch(() => {});
      }
    }).then((cleanup) => { if (cancelled) cleanup(); else unsubscribe = cleanup; }).catch(() => {});
    const poll = async () => {
      if (cancelled || !id || ticking) return;
      ticking = true;
      try {
        const next = await invoke<Snapshot | null>("plugin_snapshot");
        if (cancelled || next?.instanceId !== id) return;
        setSnapshot(next);
        if (next.status === "failed") {
          observer?.disconnect();
          opened.current = { pluginId: "", attempt: -1 };
          setError(next.error ?? "plugin_failed");
          await invoke("plugin_close", { instanceId: id });
          id = null;
        }
      } catch {
        if (!cancelled) {
          observer?.disconnect();
          opened.current = { pluginId: "", attempt: -1 };
          setError("plugin_status_unavailable");
          const target = id; id = null;
          if (target) await invoke("plugin_close", { instanceId: target }).catch(() => {});
        }
      }
      finally { ticking = false; }
    };
    const onStatus = () => { void poll(); };
    window.addEventListener("__AV_PLUGIN_STATUS__", onStatus);
    const timer = window.setInterval(poll, 400);
    return () => {
      cancelled = true; observer?.disconnect(); unsubscribe(); window.clearInterval(timer);
      currentId.current = null;
      syncLayoutRef.current = null;
      window.removeEventListener("__AV_PLUGIN_STATUS__", onStatus);
      if (id) lifecycle.current = invoke("plugin_close", { instanceId: id, suspend: true }).catch(() => {});
    };
  }, [active, pluginId, attempt]);
  const execute = async (tool: Tool, value: string | null = null) => {
    if (!snapshot || busy || snapshot.pending || snapshot.status !== "ready" || !tool.enabled) return;
    setBusy(true);
    try { await invoke("plugin_command", { instanceId: snapshot.instanceId, commandId: tool.commandId, value }); }
    catch { setError("plugin_command_rejected"); }
    finally { setBusy(false); }
  };
  const retry = () => setAttempt((value) => value + 1);
  const disabled = busy || !!snapshot?.pending || snapshot?.status !== "ready" || !!error;
  const toolbar = active ? <div className="plugin-toolbar" aria-label={message("plugin.toolbar", locale, { name })} aria-busy={busy || !!snapshot?.pending}>
    {snapshot?.items.filter((tool) => tool.placement !== "overflow" || moreOpen).map((tool) => tool.kind === "select"
      ? <select key={tool.id} aria-label={tool.label} title={tool.label} value={tool.value ?? ""} disabled={disabled || !tool.enabled} onChange={(event) => void execute(tool, event.target.value)}>{tool.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      : <button key={tool.id} className="button button-secondary" type="button" disabled={disabled || !tool.enabled} onClick={() => void execute(tool)}>{tool.label}</button>)}
    {snapshot?.items.some((tool) => tool.placement === "overflow") && <button className="button button-secondary" type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>{message(moreOpen ? "plugin.less" : "plugin.more", locale)}</button>}
    {error && <><span role="status">{error}</span><button className="button button-secondary" type="button" onClick={retry}>{message("plugin.retryNamed", locale, { name })}</button></>}
  </div> : null;
  const content = <div className="native-plugin-slot" ref={slot} aria-label={message("plugin.content", locale, { name })}>
    {error ? <section className="plugin-fallback empty-state" role="alert"><h2>{message("plugin.failedTitle", locale, { name })}</h2><p>{error}</p><p>{pluginCreationHelp(error, locale === "en")}</p><button className="button button-secondary" onClick={retry}>{message("plugin.retryNamed", locale, { name })}</button><details><summary>{message("plugin.diagnostics", locale)}</summary><pre>{JSON.stringify({ pluginId, phase: snapshot ? "runtime" : "creation", code: error, instanceId: snapshot?.instanceId, events: snapshot?.events ?? [] }, null, 2)}</pre></details></section>
      : <p className="plugin-fallback" role="status">{message(snapshot?.status === "ready" ? "plugin.ready" : "plugin.loading", locale, { name })}</p>}
  </div>;
  return { toolbar, content };
}
