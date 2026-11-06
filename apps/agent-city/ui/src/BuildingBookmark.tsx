import { useEffect, useState } from "react";
import { resolveSavedCityAssets } from "./data/provider";
import { embedded, invokeHost } from "./host";
import type { PluginResponseV1 } from "@agent-vitals/app-sdk";

type Save = { revision: number; refs: string[] };
let sequence = 0;
async function state(method: string, payload: object) {
  const requestId = `city-links-${++sequence}`;
  const response = await invokeHost<PluginResponseV1<{ revision: number; value?: { schemaVersion: number; assetRefs: string[] } | null }>>("plugin_request", { request: {
    version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId, method, payload: { key: "game-links:v1", ...payload },
  } });
  if (response.requestId !== requestId || response.version !== 1 || !response.ok || !response.result) throw new Error("save_unavailable");
  return response.result;
}
/** Native-only bookmarks; no fallback may manufacture host asset grants. */
export function BuildingBookmark({ assetRef, language, windowDays }: { assetRef: string; language: string; windowDays: number }) {
  const en = language === "en";
  const [save, setSave] = useState<Save | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [coverage, setCoverage] = useState<string | null>(null);
  useEffect(() => {
    let active = true; setCoverage(null);
    if (!save?.refs.length) return;
    void resolveSavedCityAssets(windowDays, save.refs).then((response) => {
      const result = response.result as { state?: string; assets?: Array<{ state?: string }> } | undefined;
      if (result?.state !== "ready" || !Array.isArray(result.assets)) throw new Error("resolve_unavailable");
      const counts = new Map<string, number>();
      const labels: Record<string, string> = en ? { present: "in window", outside_window: "outside window", source_deleted: "source deleted", orphaned: "source missing", unavailable: "unavailable" }
        : { present: "窗口内", outside_window: "窗口外", source_deleted: "来源已删除", orphaned: "来源缺失", unavailable: "不可用" };
      for (const asset of result.assets) { const label = labels[asset.state ?? ""] ?? labels.unavailable; counts.set(label, (counts.get(label) ?? 0) + 1); }
      if (active) setCoverage([...counts].map(([label, count]) => `${label}: ${count}`).join(" · "));
    }).catch(() => { if (active) setCoverage(en ? "Building sources could not be checked." : "暂时无法核对收藏建筑的来源。"); });
    return () => { active = false; };
  }, [save, windowDays, en]);
  useEffect(() => {
    let active = true; setSave(null); setError(false);
    if (!embedded()) return;
    void state("plugin.state.read", {}).then((result) => {
      const value = result.value;
      if (!Number.isSafeInteger(result.revision) || result.revision < 0 || (value && (value.schemaVersion !== 1 || !Array.isArray(value.assetRefs)
        || value.assetRefs.length > 200 || value.assetRefs.some((ref) => typeof ref !== "string" || !/^ca_[0-9a-f]{32}$/.test(ref))))) throw new Error("invalid_save");
      if (active) setSave({ revision: result.revision, refs: value?.assetRefs ?? [] });
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [reload]);
  const selected = save?.refs.includes(assetRef) ?? false;
  const toggle = async () => {
    if (!save || busy) return;
    const refs = selected ? save.refs.filter((ref) => ref !== assetRef) : [...save.refs, assetRef];
    setBusy(true); setError(false);
    try {
      const result = await state("plugin.state.write", { revision: save.revision, value: { schemaVersion: 1, assetRefs: refs } });
      if (result.revision !== save.revision + 1) throw new Error("invalid_save_revision");
      setSave({ revision: result.revision, refs });
    } catch { setError(true); setSave(null); }
    finally { setBusy(false); }
  };
  if (!embedded()) return <p>{en ? "Building bookmarks are available in the installed app." : "建筑收藏可在已安装的 App 中使用。"}</p>;
  return <div aria-busy={busy}>
    <button disabled={!save || busy || (!selected && save.refs.length >= 200)} onClick={() => { void toggle(); }}>
      {busy ? (en ? "Saving…" : "正在保存…") : selected ? (en ? "Remove building bookmark" : "取消建筑收藏") : (en ? "Bookmark building" : "收藏建筑")}
    </button>
    <p aria-live="polite">{save ? `${en ? "Local bookmarks" : "本地收藏"}: ${save.refs.length} / 200` : error ? (en ? "Local bookmarks unavailable." : "本地收藏暂不可用。") : en ? "Reading local bookmarks…" : "正在读取本地收藏…"}</p>
    {coverage && <p role="status">{coverage}</p>}
    {error && <p role="alert">{en ? "Save failed or changed in another window. Reload before retrying." : "保存失败或档案已被其他窗口更新，请重新读取后重试。"}<button onClick={() => setReload((value) => value + 1)}>{en ? "Reload" : "重新读取"}</button></p>}
  </div>;
}
