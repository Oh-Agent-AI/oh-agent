import { useEffect, useState } from "react";
import { embedded, invokeHost } from "./host";
import { createCityAssetBookmarkAdapter, type CityAssetBookmarkObjectClient } from "./data/cityAssetBookmarks";
import { cityAssetStateFromTypedSource, readTypedCitySourceStatusFromHost } from "./data/typedCitySessionAdapter";
import { readLegacyCityStoreSnapshot } from "./data/cityLegacyStore";
import type { PluginResponseV1, TypedObjectResultV1 } from "@agent-vitals/app-sdk";

type Save = { revision: number | null; legacyRefs: string[]; scopeRefs: string[]; refs: string[]; authoritative: boolean };
let sequence = 0;
let adapterCache: { instanceId: string; promise: ReturnType<typeof createBookmarkAdapter> } | null = null;

async function hostRequest<T>(method: string, payload: object): Promise<T> {
  const requestId = `city-links-${++sequence}`;
  const response = await invokeHost<PluginResponseV1<T>>("plugin_request", { request: {
    version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId, method, payload,
  } });
  if (response.requestId !== requestId || response.version !== 1 || !response.ok || !response.result) {
    throw new Error(response.error?.code ?? "save_unavailable");
  }
  return response.result;
}

async function readLegacyBookmarkState() {
  const snapshot = await readLegacyCityStoreSnapshot();
  return snapshot.legacyBookmarkState ?? { revision: 0, value: null };
}

async function createBookmarkAdapter() {
  const instanceId = window.__AV_PLUGIN_INSTANCE__;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedObjectClient }] = await Promise.all([import("@agent-vitals/app-sdk")]);
  const objectClient = createTypedObjectClient(instanceId, (request) =>
    invokeHost<PluginResponseV1<TypedObjectResultV1>>("plugin_request", { request })) as CityAssetBookmarkObjectClient;
  const stateClient = {
    read: () => hostRequest<{ revision: number; value: unknown }>("plugin.state.read", { key: "city-bookmarks:v1" }),
    write: (revision: number, value: { schemaVersion: 1 | 2; scopeHandle: string }) =>
      hostRequest<{ revision: number }>("plugin.state.write", { key: "city-bookmarks:v1", revision, value }),
  };
  return createCityAssetBookmarkAdapter(objectClient, stateClient);
}

function bookmarkAdapter() {
  const instanceId = window.__AV_PLUGIN_INSTANCE__;
  if (!instanceId) return Promise.reject(new Error("plugin_instance_unavailable"));
  if (!adapterCache || adapterCache.instanceId !== instanceId) adapterCache = { instanceId, promise: createBookmarkAdapter() };
  return adapterCache.promise;
}

/** Native-only bookmarks; no fallback may manufacture host asset grants. */
export function BuildingBookmark({ assetRef, stableRef, stableRefs, snapshot, language, windowDays }: {
  assetRef: string; stableRef?: string; stableRefs?: ReadonlyMap<string, string>;
  snapshot?: { data_revision: number; window: { from_ms: number; to_ms: number } };
  language: string; windowDays: number;
}) {
  const en = language === "en";
  const [save, setSave] = useState<Save | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [coverage, setCoverage] = useState<string | null>(null);
  useEffect(() => {
    let active = true; setCoverage(null);
    if (!save?.refs.length) return;
    void (async () => {
      const byAsset = new Map<string, string>();
      let adapterError: unknown;
      try {
        const adapter = await bookmarkAdapter();
        for (const asset of await adapter.readSources()) byAsset.set(asset.assetRef, asset.sourceRef);
      } catch (reason) { adapterError = reason; }
      const displayByAsset = new Map(save.refs.map((ref) => [ref, "unavailable"]));
      const references = save.refs.flatMap((ref) => {
        const stableRef = byAsset.get(ref);
        return stableRef ? [{ assetRef: ref, stableRef }] : [];
      });
      let status = "unavailable";
      let reason = adapterError instanceof Error ? adapterError.message : "typed_asset_status_unavailable";
      if (references.length && snapshot) {
        try {
          const typed = await readTypedCitySourceStatusFromHost({ references: references.map((item) => item.stableRef),
            windowDays: windowDays as 7 | 30 | 90 | 366,
            toMs: snapshot.window.to_ms, dataRevision: snapshot.data_revision });
          if (typed.dataRevision !== snapshot.data_revision || typed.windowDays !== windowDays
              || typed.window.toMs !== snapshot.window.to_ms || typed.window.fromMs !== snapshot.window.from_ms
              || typed.sources.length !== references.length) throw new Error("typed_asset_status_revision_changed");
          const assetByStableRef = new Map(references.map((item) => [item.stableRef, item.assetRef]));
          for (const source of typed.sources) {
            if (typeof source.stable_ref !== "string" || !assetByStableRef.has(source.stable_ref)) throw new Error("typed_asset_status_invalid");
            displayByAsset.set(assetByStableRef.get(source.stable_ref)!, cityAssetStateFromTypedSource(source));
          }
          status = references.length === save.refs.length && save.authoritative ? "authoritative" : "partial";
          reason = "";
        } catch (error) {
          reason = error instanceof Error ? error.message : "typed_asset_status_unavailable";
        }
      } else if (!snapshot) reason = "city_window_unavailable";
      const target = window as Window & { __CITY_TYPED_ASSET_STATUS_ROLLOUT__?: unknown };
      target.__CITY_TYPED_ASSET_STATUS_ROLLOUT__ = { source: "typed", status,
        ...(reason ? { reason } : {}), dataRevision: snapshot?.data_revision ?? null,
        compared: status === "unavailable" ? 0 : references.length, total: save.refs.length,
        coverage: references.length === save.refs.length ? "complete" : "partial", selected: "typed" };
      const displayAssets = save.refs.map((asset_ref) => ({ asset_ref, state: displayByAsset.get(asset_ref) ?? "unavailable" }));
      const counts = new Map<string, number>();
      const labels: Record<string, string> = en ? { present: "in window", outside_window: "outside window", source_deleted: "source deleted", orphaned: "source missing", unavailable: "unavailable" }
        : { present: "窗口内", outside_window: "窗口外", source_deleted: "来源已删除", orphaned: "来源缺失", unavailable: "不可用" };
      for (const asset of displayAssets) { const label = labels[asset.state ?? ""] ?? labels.unavailable; counts.set(label, (counts.get(label) ?? 0) + 1); }
      if (active) setCoverage([...counts].map(([label, count]) => `${label}: ${count}`).join(" · "));
    })().catch(() => { if (active) setCoverage(en ? "Building sources could not be checked." : "暂时无法核对收藏建筑的来源。"); });
    return () => { active = false; };
  }, [save, windowDays, en, snapshot]);
  useEffect(() => {
    let active = true; setSave(null); setError(false);
    if (!embedded()) return;
    void (async () => {
      const adapter = await bookmarkAdapter();
      const generic = await adapter.snapshot();
      const typedRefs = generic.refs;
      const authoritative = generic.authoritative;
      if (authoritative) {
        if (active) setSave({ revision: null, legacyRefs: typedRefs, scopeRefs: typedRefs, refs: typedRefs, authoritative: true });
        return;
      }
      let legacy: Awaited<ReturnType<typeof readLegacyBookmarkState>>;
      try { legacy = await readLegacyBookmarkState(); }
      catch (reason) { throw reason; }
      let revision: number | null = null;
      let legacyRefs: string[] = [];
      {
        const value = legacy.value;
        const revisionValid = Number.isSafeInteger(legacy.revision) && legacy.revision >= 0;
        const valueValid = !value || (value.schemaVersion === 1 && Array.isArray(value.assetRefs)
          && value.assetRefs.length <= 200 && value.assetRefs.every((ref) => typeof ref === "string" && /^ca_[0-9a-f]{32}$/.test(ref)));
        if (!revisionValid || !valueValid) throw new Error("invalid_save");
        if (revisionValid) revision = legacy.revision;
        if (valueValid) legacyRefs = value?.assetRefs ?? [];
      }
      let scopeRefs = typedRefs;
      const stableByAsset = new Map(stableRefs ?? []);
      if (stableRef) stableByAsset.set(assetRef, stableRef);
      let genericIsAuthoritative: boolean = authoritative;
      if (!authoritative && revision !== null) {
        try {
          const adapter = await bookmarkAdapter();
          for (let attempt = 0; attempt < 3; attempt += 1) {
            scopeRefs = await adapter.syncBookmarkedSources(
              legacyRefs.map((legacyAssetRef) => ({ assetRef: legacyAssetRef, stableRef: stableByAsset.get(legacyAssetRef) })));
            const verified = await adapter.snapshot();
            const latest = await readLegacyBookmarkState();
            const latestValue = latest.value;
            const latestValid = Number.isSafeInteger(latest.revision) && latest.revision >= 0
              && (!latestValue || (latestValue.schemaVersion === 1 && Array.isArray(latestValue.assetRefs)
                && latestValue.assetRefs.length <= 200 && latestValue.assetRefs.every((ref) => typeof ref === "string" && /^ca_[0-9a-f]{32}$/.test(ref))));
            if (!latestValid) throw new Error("invalid_save");
            const latestRefs = latestValue?.assetRefs ?? [];
            if (latest.revision !== revision || latestRefs.length !== legacyRefs.length
                || latestRefs.some((ref) => !legacyRefs.includes(ref))) {
              revision = latest.revision;
              legacyRefs = latestRefs;
              if (attempt < 2) continue;
              break;
            }
            const matches = verified.refs.length === latestRefs.length && latestRefs.every((ref) => verified.refs.includes(ref));
            if (matches) {
              genericIsAuthoritative = await adapter.markAuthoritative();
              if (genericIsAuthoritative) {
                scopeRefs = (await adapter.snapshot()).refs;
                revision = latest.revision;
                legacyRefs = latestRefs;
              }
            }
            break;
          }
        } catch { /* Keep the legacy state authoritative until a complete import can be verified. */ }
      }
      if (active) setSave({ revision, legacyRefs, scopeRefs, refs: genericIsAuthoritative ? scopeRefs : legacyRefs, authoritative: genericIsAuthoritative });
    })().catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [reload, assetRef, stableRef, stableRefs]);
  const selected = save?.refs.includes(assetRef) ?? false;
  const toggle = async () => {
    if (!save || busy) return;
    setBusy(true); setError(false);
    try {
      const stableByAsset = new Map(stableRefs ?? []);
      if (stableRef) stableByAsset.set(assetRef, stableRef);
      const adapter = await bookmarkAdapter();
      const genericSnapshot = await adapter.snapshot();
      const genericAuthority = save.authoritative || genericSnapshot.authoritative;
      if (!genericAuthority) throw new Error("bookmark_migration_incomplete");
      const scopeRefs = await adapter.setBookmarked(assetRef, stableByAsset.get(assetRef), !selected);
      setSave({ revision: null, legacyRefs: scopeRefs, scopeRefs, refs: scopeRefs, authoritative: true });
    } catch { setError(true); setSave(null); }
    finally { setBusy(false); }
  };
  if (!embedded()) return <p>{en ? "Building bookmarks are available in the installed app." : "建筑收藏可在已安装的 App 中使用。"}</p>;
  return <div aria-busy={busy}>
    <button disabled={!save || !save.authoritative || busy || (!selected && save.refs.length >= 200)} onClick={() => { void toggle(); }}>
      {busy ? (en ? "Saving…" : "正在保存…") : selected ? (en ? "Remove building bookmark" : "取消建筑收藏") : (en ? "Bookmark building" : "收藏建筑")}
    </button>
    <p aria-live="polite">{save ? `${en ? "Local bookmarks" : "本地收藏"}: ${save.refs.length} / 200` : error ? (en ? "Local bookmarks unavailable." : "本地收藏暂不可用。") : en ? "Reading local bookmarks…" : "正在读取本地收藏…"}</p>
    {save && !save.authoritative && <p role="status">{en ? "Legacy bookmarks are not fully imported yet. Retry migration before editing." : "旧收藏尚未完成迁移；请重试迁移后再修改。"}<button disabled={busy} onClick={() => setReload((value) => value + 1)}>{en ? "Retry migration" : "重试迁移"}</button></p>}
    {coverage && <p role="status">{coverage}</p>}
    {error && <p role="alert">{en ? "Save failed or changed in another window. Reload before retrying." : "保存失败或档案已被其他窗口更新，请重新读取后重试。"}<button onClick={() => setReload((value) => value + 1)}>{en ? "Reload" : "重新读取"}</button></p>}
  </div>;
}
