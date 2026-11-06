import { useEffect, useState, type RefObject } from "react";
import type { CityEngine } from "../../engine/CityEngine";
import { anchorsFromCity, prepareFightTerrainAsync } from "./citySite";
import { startPreparedSearch } from "./fightSearchRunner";
import { cacheCatalog, cachedCatalog, encountersFromCatalog, type MonsterEncounter } from "./monsterEncounters";

type CityRevision = { layout: NonNullable<CityEngine["currentLayout"]>; model: NonNullable<CityEngine["currentModel"]> };
export type EncounterState = { status: "loading" | "ready" | "error"; encounters: MonsterEncounter[] };

export function useMonsterEncounters(engine: RefObject<CityEngine | null>, enabled: boolean): EncounterState {
  const [revision, setRevision] = useState<CityRevision | null>(null);
  const [state, setState] = useState<EncounterState>({ status: "loading", encounters: [] });
  useEffect(() => {
    if (!enabled) { setRevision(null); return; }
    const poll = () => {
      const layout = engine.current?.currentLayout;
      const model = engine.current?.currentModel;
      setRevision((old) => !layout || !model ? null : old?.layout === layout && old.model === model ? old : { layout, model });
    };
    poll();
    const timer = window.setInterval(poll, 500);
    return () => window.clearInterval(timer);
  }, [engine, enabled]);
  useEffect(() => {
    if (!revision || !enabled) { setState({ status: "loading", encounters: [] }); return; }
    const { layout, model } = revision;
    const cached = cachedCatalog(layout, model);
    if (cached) { setState({ status: "ready", encounters: encountersFromCatalog(layout, model, cached, layout) }); return; }
    const controller = new AbortController();
    let alive = true;
    let cancel: (() => void) | undefined;
    const current = () => alive && engine.current?.currentLayout === layout && engine.current?.currentModel === model;
    setState({ status: "loading", encounters: [] });
    void (async () => {
      try {
        const snapshot = await prepareFightTerrainAsync(layout.terrain, anchorsFromCity(layout, model), { signal: controller.signal, sliceMs: 8 });
        if (!current()) return;
        cancel = startPreparedSearch(snapshot, layout.roadEdges, {
          onResult: (catalog) => {
            if (!current()) return;
            cacheCatalog(layout, model, catalog);
            setState({ status: "ready", encounters: encountersFromCatalog(layout, model, catalog, layout) });
          },
          onError: (error) => { if (current()) { console.warn("monster encounter search failed", error); setState({ status: "error", encounters: [] }); } },
        }, controller.signal).cancel;
      } catch (error) {
        if (current() && (error as { name?: string })?.name !== "AbortError") {
          console.warn("monster encounter search failed", error);
          setState({ status: "error", encounters: [] });
        }
      }
    })();
    return () => { alive = false; controller.abort(); cancel?.(); };
  }, [enabled, engine, revision]);
  if (!enabled || !revision || engine.current?.currentLayout !== revision.layout || engine.current?.currentModel !== revision.model) return { status: "loading", encounters: [] };
  return state.encounters.every((point) => point.layout === revision.layout && point.model === revision.model) ? state : { status: "loading", encounters: [] };
}
