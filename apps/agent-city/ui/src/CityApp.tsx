import { useEffect, useRef, useState } from "react";
import { buildCityModel, type CitySessionRow } from "./cityModel";
import { prepareCityLayout } from "./engine/cityLayout";
import { MIAMI_COASTAL } from "./engine/citySeaside";
import { CityEngine } from "./engine/CityEngine";
import { tauriCityDataProvider, cityDataProtocol, readBuildingOverrides, type CityProjectionV1 } from "./data/provider";
import { dispatchEntityChanged, ENTITY_CHANGED_EVENT, parseEntityChanged } from "./engine/entityEvents";
import { entityChangedFromBuilding } from "./engine/sessionKitConstruction";
import { SquadFeed } from "./SquadFeed";
import {
  applySquadEnvelope, claimsFromRows, emptyFeed, expireClaims, parseSquadEnvelope, SQUAD_EVENT,
  type SquadFeedState,
} from "./engine/squadEvents";
import "./city.css";
import { embedded, connect, observeHealth, noteBusy, publishToolbar, type Tool } from "./host";
import type { EngineQualityMode } from "./engine/CityEngine";
import { CityExperience, useCityExperience } from "./CityExperience";
import { usePlanRepair } from "./planRepair/usePlanRepair";
import { CityMinimap } from "./minimap/CityMinimap";
import { supportsBackgroundFilm } from "./export/filmJob";
import { cityText, cityView, useCityLanguage } from "./i18n";
import { replayStartMs } from "./replayRange";
import { useCityGame } from "./game/useCityGame";
import { MechaBoard } from "./game/MechaBoard";
import { prewarmAudioContext } from "./game/GameSfx";
import { useCityDrivingPlay } from "./game/useCityDrivingPlay";
import { DrivingHud } from "./game/DrivingHud";
import type { PlayTarget } from "./engine/render/playableVehicles";
import { useRoadAudit } from "./game/useRoadAudit";
import { RoadAuditPanel } from "./game/ui/RoadAuditPanel";
import type { PlanningWorkSnapshot } from "./engine/planner/operationBudget";

declare global {
  interface Window {
    __AV_CITY_PROBE__?: () => Record<string, unknown>;
    __AV_CITY_SET_HOVERED__?: (id: string | null) => void;
    __AV_CITY_SELECT__?: (id: string | null) => void;
    __AV_CITY_REPLAY_BUILD__?: (assetOrSession?: string) => boolean;
  }
}

const windowOptions = [7, 30, 90, 366] as const;
type WindowDays = (typeof windowOptions)[number];
type CityLoadState = Readonly<{ stage: "data" | "model" | "planning" | "mounting" | "rendering"; work: number | null }>;

function projectionStatusLabel(data: CityProjectionV1): string {
  if (data.status === "ready") return data.source === "local"
    ? `本机真实数据 · ${data.coverage.truncated ? `载入 ${data.coverage.returned}/${data.coverage.total} 会话` : "窗口内会话"} · ${data.coverage.findings_state === "partial" ? "异常为部分已入库投影" : "异常统计未接入"}`
    : "合成 fixture · 尚未接入真实数据源";
  if (data.status === "empty") return "当前时间范围没有会话";
  if (data.status === "stale") return "数据可能已过期";
  return "City 数据不可用";
}

export function CityApp() {
  const language = useCityLanguage();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CityEngine | null>(null);
  const [projection, setProjection] = useState<CityProjectionV1 | null>(null);
  const [windowDays, setWindowDays] = useState<WindowDays>(() => {
    const params = new URLSearchParams(location.search);
    const days = Number(params.get("windowDays"));
    // The browser landing starts with its mock window, avoiding a second full
    // scene build. The native default remains the latest 500 sessions/year.
    return embedded() && params.get("presentation") === "landing" && windowOptions.includes(days as WindowDays)
      ? days as WindowDays : 366;
  });
  const [status, setStatus] = useState("正在载入 City 插槽数据…");
  const [sceneUnavailable, setSceneUnavailable] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [firstModelFrame, setFirstModelFrame] = useState(false);
  const [cityLoad, setCityLoad] = useState<CityLoadState>({ stage: "data", work: null });
  const [quality, setQuality] = useState<EngineQualityMode>("auto");
  const [labels, setLabels] = useState(true);
  const [cinema, setCinema] = useState(false);
  const [roadAuditOpen, setRoadAuditOpen] = useState(false);
  const [mechaOpen, setMechaOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const experience = useCityExperience(engineRef, projection);
  // 飞机与汽车共用宿主运行时；当前城市的自由驾驶从工具栏进入。
  // 必须先于引擎创建 effect 声明——卸载清理时先退出游戏（归还相机）再销毁引擎。
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const cinemaRef = useRef(cinema);
  cinemaRef.current = cinema;
  const filmRef = useRef(!!experience.film);
  filmRef.current = !!experience.film;
  const busyRef = useRef(experience.busy);
  busyRef.current = experience.busy;
  const drivingActive = useRef(false);
  const planRepairActive = useRef(false);
  const game = useCityGame(engineRef, {
    cinemaActive: () => cinemaRef.current,
    filmActive: () => filmRef.current,
    busy: () => busyRef.current || drivingActive.current,
    labelsVisible: () => labelsRef.current,
    requestRefresh: () => setRefresh((value) => value + 1),
    locale: () => (language === "en" ? "en" : "zh-Hans"),
  });
  const driving = useCityDrivingPlay(engineRef, {
    cinemaActive: () => cinemaRef.current,
    gameActive: () => game.active,
    busy: () => busyRef.current || filmRef.current || planRepairActive.current,
  });
  drivingActive.current = driving.active;
  // 规划修复（开发开关 ?cityPlan / cityPlanDev=1；未开启时 hook 什么都不做）。与游戏/航拍/导出/忙碌互斥。
  const planRepair = usePlanRepair(engineRef, { seed: experience.seed, model: experience.model, blocked: cinema || game.active || driving.active || experience.busy || !!experience.film });
  // 点停车场里的车 / 机坪上的飞机直接开（2026-10-22）：与工具栏「驾车」「驾驶飞机」同一组互斥条件——
  // 航拍、导出、忙碌、修复城市、已经在开车或飞行时不响应（引擎只在非驾驶世界里派发点击）。
  const playRef = useRef<(target: PlayTarget) => void>(() => {});
  playRef.current = (target) => {
    if (cinema || game.active || driving.active || experience.busy || !!experience.film || planRepair.state.active) return;
    experience.setOptions(false); experience.clearSelection();
    if (target.kind === "car") driving.enterAt(target);
    else game.enterPracticeFrom(target);
  };
  planRepairActive.current = planRepair.state.active;
  const appliedWindow = useRef<number | null>(null);
  const fingerprint = useRef("");
  const geographyKey = useRef("");
  const geographyAbort = useRef<AbortController | null>(null);
  const liveCity = useRef(false);
  const seenEntityEvents = useRef(new Set<string>());
  const [squad, setSquad] = useState<SquadFeedState>(emptyFeed);
  const [squadOpen, setSquadOpen] = useState(true);
  const [squadNow, setSquadNow] = useState(() => Date.now());
  useEffect(() => () => { geographyAbort.current?.abort(); }, []);
  useEffect(() => observeHealth(() => engineRef.current?.diagnosticState() ?? { engineMissing: true }), []);
  useEffect(() => {
    const invalidated = () => setRefresh((value) => value + 1);
    window.addEventListener("__AV_PLUGIN_INVALIDATED__", invalidated);
    return () => window.removeEventListener("__AV_PLUGIN_INVALIDATED__", invalidated);
  }, []);
  useEffect(() => {
    const onEntity = (event: Event) => {
      const parsed = parseEntityChanged((event as CustomEvent).detail);
      if (!parsed || seenEntityEvents.current.has(parsed.event_id)) return;
      seenEntityEvents.current.add(parsed.event_id);
      dispatchEntityChanged(parsed, {
        building: (changed) => { engineRef.current?.applyBuildingChanged(changed, liveCity.current); },
      });
    };
    window.addEventListener(ENTITY_CHANGED_EVENT, onEntity);
    return () => window.removeEventListener(ENTITY_CHANGED_EVENT, onEntity);
  }, []);
  useEffect(() => {
    const onSquad = (event: Event) => {
      const parsed = parseSquadEnvelope((event as CustomEvent).detail);
      if (!parsed) return;
      const nowSecs = Math.floor(Date.now() / 1000);
      setSquad((current) => applySquadEnvelope(current, parsed, nowSecs));
    };
    window.addEventListener(SQUAD_EVENT, onSquad);
    const tick = window.setInterval(() => {
      setSquadNow(Date.now());
      const nowSecs = Math.floor(Date.now() / 1000);
      setSquad((current) => {
        const claims = expireClaims(current.claims, nowSecs);
        if (Object.keys(claims).length === Object.keys(current.claims).length) return current;
        return { ...current, claims };
      });
    }, 1000);
    return () => { window.removeEventListener(SQUAD_EVENT, onSquad); window.clearInterval(tick); };
  }, []);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const present = new Set(Object.keys(squad.claims));
    for (const claim of Object.values(squad.claims)) engine.applyClaimTint(claim);
    for (const row of engine.inspectScene().claims as Array<{ assetRef: string; sessionId: string }>) {
      if (!present.has(row.assetRef)) engine.clearClaimTint(row.sessionId);
    }
  }, [squad.claims, firstModelFrame]);
  useEffect(() => { liveCity.current = firstModelFrame; }, [firstModelFrame]);
  useEffect(() => {
    if (!firstModelFrame) return;
    let cancelled = false;
    void (async () => {
      await noteBusy(8_000).catch(() => {});
      if (!cancelled) prewarmAudioContext();
    })();
    return () => { cancelled = true; };
  }, [firstModelFrame]);

  useEffect(() => {
    let active = true;
    const loading = new AbortController();
    setStatus("正在更新 City 插槽数据…");
    const apply = (data: CityProjectionV1, paging = false) => {
      setProjection(data);
      setDataLoaded(true);
      setCityLoad({ stage: "model", work: null });
      setStatus(paging && data.coverage.truncated
        ? `${projectionStatusLabel(data)} · 继续载入会话建筑`
        : projectionStatusLabel(data));
    };
    tauriCityDataProvider.getProjection({ windowDays, signal: loading.signal, onStage: (stage) => {
      if (active && stage !== "ready") setStatus(stage === "reading_summary" ? "正在读取全窗口统计…" : "正在读取会话建筑…");
    }, onPartial: (data) => { if (active) apply(data, true); } }).then((data) => {
      if (active) apply(data);
    }).catch(() => {
      if (!active) return;
      setDataLoaded(true);
      // Keep a city that already rendered; packaged v3 fallback happens inside the provider.
      setProjection((current) => current ?? null);
      setStatus((current) => current && !current.startsWith("正在") ? current : "City 数据暂不可用");
    });
    return () => { active = false; loading.abort(); };
  }, [windowDays, refresh]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: CityEngine;
    try {
      engine = new CityEngine({ canvas, ...experience.callbacks, onPlay: (target) => playRef.current(target), onFirstFrame: () => setFirstModelFrame(true), onCinematic: (_elapsed, _plan, ended) => {
        experience.callbacks.onCinematic(_elapsed, _plan, ended);
        if (ended) { setCinema(false); }
      } });
    } catch {
      setSceneUnavailable(true);
      return;
    }
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!projection || !engineRef.current || experience.busy || game.active || driving.active) return;
    const engine = engineRef.current;
    const from = Date.parse(projection.window.from);
    const to = Date.parse(projection.window.to);
    setCityLoad({ stage: "model", work: null });
    const rows: CitySessionRow[] = projection.sessions.map((session) => ({
      session_ref: session.id,
      asset_ref: session.asset_ref ?? null,
      harness: session.harness,
      title: session.title ?? null,
      title_source: session.title_source ?? null,
      first_event_at: session.first_event_at,
      last_event_at: session.last_event_at,
      event_count: session.event_count ?? 1,
      peak_tokens: session.tokens.total,
      model_ids: session.model_ids ?? [],
      tokens: {
        uncached_input_tokens: session.tokens.uncached_input ?? session.tokens.input,
        cache_read_tokens: session.tokens.cache_read ?? 0,
        cache_write_tokens: session.tokens.cache_write ?? 0,
        output_tokens: session.tokens.output,
        total: session.tokens.total,
      },
      cost_minor: session.cost_minor && ["metered_actual", "metered_estimate", "fixed_subscription", "api_equivalent", "other"].includes(session.cost_minor.basis)
        ? session.cost_minor as CitySessionRow["cost_minor"] : null,
      cost_status: session.cost_status ?? { state: "unavailable", reason: "cost_not_projected", has_unresolved: true },
    }));
    const model = buildCityModel({
      harnessNames: Object.fromEntries(projection.harnesses.map((h) => [h.id, h.display_name])),
      rows,
      findings: projection.findings.map((finding) => ({
        harness: finding.harness,
        rule: "harness_summary",
        severity: finding.severity,
        status_rollup: { open: finding.count, later: 0 },
      })),
      windowStartMs: replayStartMs(projection.sessions, from, to),
      windowEndMs: to,
      windowLabel: projection.window.label,
      totalSessions: projection.coverage.total,
      truncated: projection.coverage.truncated,
      generatedAt: Date.parse(projection.generated_at ?? new Date().toISOString()),
    });
    experience.modelRef.current = model;
    experience.setModel(model);
    // Geography is keyed by window + planned population, not the sessions array.
    // Occupant-only page updates must not abort the in-flight island plan or hide the first frame.
    const planned = Math.min(4000, Math.max(projection.sessions.length, projection.coverage.total));
    const geography = JSON.stringify([projection.window, experience.seed, planned]);
    const occupants = projection.sessions.map((session) => session.id).join("\0");
    const signature = `${geography}|${occupants}|${JSON.stringify(projection.findings)}`;
    if (signature === fingerprint.current) { experience.refreshSelection(); return; }
    if (geographyKey.current !== geography) {
      geographyAbort.current?.abort();
      const preparation = new AbortController();
      geographyAbort.current = preparation;
      geographyKey.current = geography;
      fingerprint.current = "";
      setFirstModelFrame(false);
      setCityLoad({ stage: "planning", work: null });
      void prepareCityLayout(model, experience.seed, MIAMI_COASTAL, { signal: preparation.signal,
        onPlanningProgress: (snapshot: PlanningWorkSnapshot) => {
          const work = Object.values(snapshot.consumed).reduce((sum, value) => sum + value, 0);
          setCityLoad({ stage: "planning", work });
        } }).then(async () => {
        if (preparation.signal.aborted || engineRef.current !== engine) return;
        setCityLoad({ stage: "mounting", work: null });
        await noteBusy(15_000).catch(() => {});
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (preparation.signal.aborted || engineRef.current !== engine) return;
        engine.applyModel(model, false);
        setCityLoad({ stage: "rendering", work: null });
        // applyModel synchronously renders the first frame for this model before returning.
        setFirstModelFrame(true);
        appliedWindow.current = projection.window.days;
        fingerprint.current = signature;
        experience.refreshSelection();
      }).catch(() => {
        if (!preparation.signal.aborted) { setSceneUnavailable(true); setCityLoad({ stage: "data", work: null }); }
      });
      experience.refreshSelection();
      return;
    }
    if (!firstModelFrame) { experience.refreshSelection(); return; }
    const preparation = new AbortController();
    void prepareCityLayout(model, experience.seed, MIAMI_COASTAL, { signal: preparation.signal }).then(async () => {
      if (preparation.signal.aborted || engineRef.current !== engine) return;
      await noteBusy(8_000).catch(() => {});
      if (preparation.signal.aborted || engineRef.current !== engine) return;
      engine.applyModel(model, true);
      fingerprint.current = signature;
      experience.refreshSelection();
    }).catch(() => {});
    experience.refreshSelection();
    return () => preparation.abort();
  }, [projection, experience.busy, experience.seed, game.active, driving.active, firstModelFrame]);

  useEffect(() => {
    if (!projection?.v3_context || !embedded()) return;
    let active = true;
    const context = projection.v3_context;
    const refs = projection.sessions.map((session) => session.asset_ref).filter((id): id is string => typeof id === "string");
    const applyOverrides = async (animate: boolean) => {
      const { overrides, events, claims, squadMailbox } = await readBuildingOverrides(context, refs);
      if (!active) return;
      for (const event of events) seenEntityEvents.current.add(event.event_id);
      const nowSecs = Math.floor(Date.now() / 1000);
      setSquad((current) => {
        const stored = claimsFromRows(claims, nowSecs);
        let next = {
          ...current,
          claims: Object.keys(current.claims).length ? expireClaims(current.claims, nowSecs) : stored,
        };
        const parsed = parseSquadEnvelope(squadMailbox);
        if (parsed) next = applySquadEnvelope(next, parsed, nowSecs);
        return next;
      });
      for (const row of overrides) {
        const latest = events.find((event) => event.entity_id === row.asset_ref && event.action === "set" && event.revision === row.revision);
        engineRef.current?.applyBuildingChanged(entityChangedFromBuilding({
          asset_ref: row.asset_ref,
          event_id: latest?.event_id,
          revision: row.revision,
          kind: "set",
          source: "override",
          model: row.model,
        }), animate && liveCity.current);
      }
    };
    void applyOverrides(false).catch(() => {});
    const timer = window.setInterval(() => {
      if (document.hidden || !liveCity.current) return;
      void (async () => {
        try {
          const { overrides, events } = await readBuildingOverrides(context, refs);
          for (const event of events) {
            if (seenEntityEvents.current.has(event.event_id)) continue;
            seenEntityEvents.current.add(event.event_id);
            const row = overrides.find((item) => item.asset_ref === event.entity_id);
            if (event.action === "reset") {
              engineRef.current?.applyBuildingChanged(event, true);
            } else if (row) {
              engineRef.current?.applyBuildingChanged(entityChangedFromBuilding({
                asset_ref: row.asset_ref, event_id: event.event_id, revision: event.revision,
                kind: "set", source: "override", model: row.model,
              }), true);
            }
          }
        } catch { /* poll is a backup; push is preferred */ }
      })();
    }, 8_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [projection]);

  useEffect(() => {
    window.__AV_CITY_PROBE__ = () => {
      const scene = engineRef.current?.inspectScene() ?? null;
      return {
        protocol: cityDataProtocol(), search: location.search, coverage: projection?.coverage ?? null,
        source: projection?.source ?? null, hasV3Context: !!projection?.v3_context,
        sessionCount: projection?.sessions.length ?? 0, firstModelFrame, cityLoad, status,
        selected: experience.selected, details: experience.details, scene,
      };
    };
    window.__AV_CITY_SET_HOVERED__ = (id) => { engineRef.current?.setHovered(id); };
    window.__AV_CITY_SELECT__ = (id) => { experience.setSelected(id); engineRef.current?.setSelected(id); };
    window.__AV_CITY_REPLAY_BUILD__ = (assetOrSession) => {
      const engine = engineRef.current;
      if (!engine) return false;
      if (assetOrSession) return engine.replayBuilding(assetOrSession);
      const kits = engine.inspectScene().kits as Array<{ sessionId: string }> | undefined;
      const first = kits?.[0]?.sessionId;
      return first ? engine.replayBuilding(first) : false;
    };
    return () => { delete window.__AV_CITY_PROBE__; delete window.__AV_CITY_SET_HOVERED__; delete window.__AV_CITY_SELECT__; delete window.__AV_CITY_REPLAY_BUILD__; };
  });

  useEffect(() => {
    if (experience.busy || game.active || driving.active) return;
    if (!cinema) engineRef.current?.setLabelsVisible(labels);
    engineRef.current?.setQualityMode(quality);
  }, [projection, labels, quality, cinema, experience.busy, game.active, driving.active]);

  const dataAvailable = projection !== null && projection.status !== "unavailable";
  const sceneReady = dataAvailable && projection.status !== "empty" && !sceneUnavailable && firstModelFrame;
  // The host projection request precedes model/planning progress. Keep the same
  // loading shell visible from the first render, including a slow summary query.
  const cityLoading = !sceneUnavailable && (!dataLoaded || (dataAvailable && projection?.status !== "empty" && !firstModelFrame));
  const roadAuditEnabled = sceneReady && !driving.active && !game.active && !cinema && !experience.busy && !experience.film && !planRepair.state.active;
  const roadAudit = useRoadAudit(engineRef, roadAuditEnabled && roadAuditOpen);
  const toolbarReady = true; // UI/command channel ready; scene actions stay disabled until the first model frame.
  const tools: Tool[] = [
    // 时间范围、显示标签移入城市设置（用户：这两个应放设置里）；画质同样在设置里。city.window / city.labels 命令仍保留给宿主与自动化。
    { id: "catalog", commandId: "city.catalog", label: "建筑说明", kind: "button", enabled: !cinema && !game.active },
    { id: "reset", commandId: "city.reset", label: "重置视角", kind: "button", enabled: sceneReady && !cinema && !game.active && !experience.busy },
    { id: "cinema", commandId: "city.cinema", label: cinema ? "停止航拍" : "航拍", kind: "button", enabled: sceneReady && !experience.busy && !game.active },
    { id: "photo", commandId: "city.photo", label: experience.photoBusy ? "正在拍照" : "拍照", kind: "button", enabled: sceneReady && !cinema && !game.active && !experience.busy && !experience.film },
    { id: "film", commandId: "city.film", label: experience.film ? `取消导出 · ${Math.round(experience.film.frame / experience.film.total * 100)}%` : "导出视频", kind: "button", enabled: !!experience.film || (sceneReady && !cinema && !game.active && !experience.busy && supportsBackgroundFilm()) },
    { id: "road-audit", commandId: "city.road-audit", label: roadAuditOpen ? "关闭道路审计" : "道路审计", kind: "button", enabled: roadAuditEnabled },
    { id: "settings", commandId: "city.settings", label: "城市设置", kind: "button", enabled: !cinema && !game.active },
    // 游戏模式（开发开关门控）：平时「驾驶飞机」直接进自由练习（挑战仍在城市设置）；
    // 游戏中变「退出游戏」——即计划 §3 要求的宿主级通用退出入口。上限 8→9 见 host 校验器。
    { id: "game", commandId: "city.game", label: game.active ? "退出游戏" : "驾驶飞机", kind: "button" as const, enabled: sceneReady && !cinema && !experience.busy && !experience.film },
    // 修复城市入口放在「更多工具」里（用户：不要悬浮在画面上）。进入后的编辑面板仍在页面内；
    // 上限 9→10 见 host 校验器（plugin_host.rs::valid_tools）。
    { id: "repair", commandId: "city.repair", label: planRepair.state.active ? "退出修复" : "修复城市", kind: "button" as const, enabled: planRepair.state.active || (sceneReady && !cinema && !game.active && !experience.busy && !experience.film) },
    { id: "car", commandId: "city.car", label: driving.active ? "退出驾驶" : "驾车", kind: "button" as const,
      enabled: driving.active || (sceneReady && !cinema && !game.active && !experience.busy && !experience.film && !planRepair.state.active) },
  ].map((tool) => ({ ...tool, enabled: tool.id === "car" ? tool.enabled : tool.enabled && !driving.active })).map((tool: { id: string; label: string; options?: Array<{ value: string; label: string }> }) => ({ ...tool, placement: tool.id === "cinema" || tool.id === "game" || tool.id === "car" || tool.id === "film" && experience.film ? "primary" : "overflow", label: cityText(tool.label, language), options: tool.options?.map((option) => ({ ...option, label: cityText(option.label, language) })) })) as Tool[];
  const execute = (commandId: string, value?: string) => {
    const engine = engineRef.current;
    if (driving.active && commandId !== "city.car") throw new Error("driving_active");
    switch (commandId) {
      case "city.window": {
        const days = Number(value);
        if (!windowOptions.includes(days as WindowDays)) throw new Error("invalid_window");
        setWindowDays(days as WindowDays); break;
      }
      case "city.quality":
        if (!["auto", "high", "eco"].includes(value ?? "")) throw new Error("invalid_quality");
        engine?.setQualityMode(value as EngineQualityMode); setQuality(value as EngineQualityMode); break;
      case "city.labels": engine?.setLabelsVisible(!labels); setLabels(!labels); break;
      case "city.reset": engine?.resetView(); break;
      case "city.cinema":
        if (cinema) { engine?.stopCinematic(); engine?.setLabelsVisible(labels); setCinema(false); }
        else { experience.clearSelection(); experience.live(); if (!engine?.startCinematic(experience.cut)) throw new Error("cinema_unavailable"); setCinema(true); }
        break;
      case "city.photo": void experience.photo(); break;
      case "city.film": void experience.exportFilm(); break;
      case "city.road-audit":
        if (!roadAuditEnabled) throw new Error("audit_unavailable");
        setRoadAuditOpen(!roadAuditOpen); break;
      case "city.settings": experience.setOptions(!experience.options); break;
      case "city.catalog": experience.setCatalog(!experience.catalog); break;
      case "city.repair":
        if (planRepair.state.active) planRepair.exit(); else planRepair.enter();
        break;
      case "city.car":
        if (driving.active) driving.exit();
        else if (sceneReady) {
          experience.setOptions(false); experience.clearSelection(); driving.enter();
        }
        break;
      case "city.game":
        if (game.active) game.exit();
        else game.enterPractice();
        break;
      default: throw new Error("command_unavailable");
    }
  };
  // 宿主命令监听只注册一次、永远调用最新的 execute：此前按依赖列表重注册，列表里没有 model，
  // 模型晚于首次注册才就绪时 execute 里的 planRepair.enter 还是 model=null 的旧闭包，静默 return——
  // 宿主日志显示「命令成功」而界面毫无反应（修复城市入口的真机症状）。
  const executeRef = useRef(execute);
  executeRef.current = execute;
  useEffect(() => connect((command) => executeRef.current(command.commandId, command.value)), []);
  // Publishing the first toolbar acknowledges the responsive plugin shell, not
  // scene completion. Planning runs on a local worker while scene tools stay disabled.
  useEffect(() => { if (toolbarReady) publishToolbar(tools); }, [language, toolbarReady, windowDays, quality, labels, cinema, roadAuditOpen, sceneReady, sceneUnavailable, game.active, driving.active, planRepair.state.active, experience.busy, experience.film?.frame, experience.film?.total]);
  const sceneMessage = sceneUnavailable ? "当前环境无法显示三维城市，仍可查看会话摘要。"
    : !dataAvailable || projection.status === "empty" ? status : null;
  return cityView((
    <section className="city-app" aria-label="Agent City">
      <canvas className="city-canvas" ref={canvasRef} aria-label="Agent City 三维城市" style={{ visibility: sceneMessage && !game.active ? "hidden" : "visible" }} />
      {cityLoading && <div className="city-loading" role="status" aria-live="polite">
        <div className="city-loading-card"><div className="city-loading-mark" aria-hidden="true"><span /><span /><span /><i /></div>
          <p className="city-loading-kicker">AGENT CITY</p>
          <h2>{cityLoad.stage === "data" ? "读取城市数据" : cityLoad.stage === "model" ? "整理城市数据" : cityLoad.stage === "planning" ? "规划道路与街区" : cityLoad.stage === "mounting" ? "装配城市" : "等待城市首帧"}</h2>
          <p>{cityLoad.stage === "data" ? status : cityLoad.stage === "model" ? "正在组织会话与建筑数据" : cityLoad.stage === "planning" ? cityLoad.work === null ? "正在计算道路、地形与街区" : `规划器已完成 ${cityLoad.work.toLocaleString()} 项工作单元` : cityLoad.stage === "mounting" ? "正在创建三维场景对象" : "城市即将就绪"}</p>
          <div className="city-loading-track" aria-hidden="true"><span /></div>
          <small>{cityLoad.stage === "planning" && cityLoad.work !== null ? "显示规划器实际完成的工作量，不代表百分比" : "复杂城市需要一些时间，请稍候"}</small>
        </div>
      </div>}
      {sceneMessage && !cityLoading && !game.active && <p className="city-scene-message" role="status">{sceneMessage}</p>}
      {!embedded() && <header className="city-header">
        <div className="city-local-toolbar">{tools.map((tool) => tool.kind === "select"
          ? <select key={tool.id} aria-label={tool.label} value={tool.value} disabled={!tool.enabled} onChange={(event) => execute(tool.commandId, event.target.value)}>{tool.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          : <button key={tool.id} disabled={!tool.enabled} onClick={() => execute(tool.commandId)}>{tool.label}</button>)}</div>
      </header>}
      {!cinema && !game.active && !driving.active && sceneReady && <SquadFeed
        items={squad.items} nowMs={squadNow} open={squadOpen} onOpen={setSquadOpen}
        onFocus={(assetRef) => { engineRef.current?.focusBuilding(assetRef); }} />}
      <div hidden={driving.active}><CityExperience ui={experience} disabled={!sceneReady} cinema={cinema} status={status} quality={quality} game={game} planRepair={planRepair}
        windowDays={windowDays} windowOptions={windowOptions} onWindowDays={(days) => setWindowDays(days as WindowDays)} labels={labels} onLabels={(next) => { engineRef.current?.setLabelsVisible(next); setLabels(next); }}
        onQuality={(value) => { if (["auto", "high", "eco"].includes(value)) { engineRef.current?.setQualityMode(value as EngineQualityMode); setQuality(value as EngineQualityMode); } }}
        onMecha={() => { if (!game.active && !driving.active && !cinema) setMechaOpen(true); }} /></div>
      {mechaOpen && !game.active && !driving.active && <MechaBoard locale={language === "en" ? "en" : "zh-Hans"} onClose={() => setMechaOpen(false)} />}
      <CityMinimap engine={engineRef} language={language} driving={{ active: driving.active, pose: driving.pose }}
        hidden={!sceneReady || cinema || game.active || !!experience.film || driving.hud.phase === "preparing" || driving.hud.phase === "error"} />
      <DrivingHud model={{ active: driving.active, choosingVehicle: driving.choosingVehicle, vtol: driving.vtol, entryError: driving.entryError,
        initialPaused: driving.initialPaused, hud: driving.hud, preparationProgress: driving.preparationProgress, events: driving.events, diagnostics: driving.diagnostics(),
        roadCheck: driving.roadCheck }}
        actions={{ selectVehicle: driving.selectVehicle, clearEntryError: driving.clearEntryError, exit: driving.exit, pause: driving.pause,
          resume: driving.resume, openUiContext: driving.openUiContext }}
        locale={language === "en" ? "en" : "zh-Hans"} sound={driving.sound} />
      {roadAuditEnabled && roadAuditOpen && <RoadAuditPanel snapshot={roadAudit.snapshot} run={() => { void roadAudit.run(); }} cancel={() => roadAudit.cancel()}
        engineRef={engineRef} locale={language === "en" ? "en" : "zh-Hans"} canRun={roadAuditEnabled} history={roadAudit.history} historySaved={roadAudit.historySaved} close={() => setRoadAuditOpen(false)} />}
    </section>
  ), language);
}
