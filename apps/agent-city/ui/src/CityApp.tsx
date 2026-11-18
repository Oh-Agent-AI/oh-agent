import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { buildCityModel } from "./cityModel";
import { buildIndependentCityModel } from "./viewport/independentCityModel";
import { prepareCityWorldLayout } from "./engine/cityLayout";
import { readCityAppearancePreference, type CityWorldProfileV1 } from "./engine/cityWorldProfile";
import { createCityWorldProfileCallHandlers } from "./engine/cityWorldProfileCalls";
import { CityEngine } from "./engine/CityEngine";
import { tauriCityDataProvider, cityDataProtocol, readBuildingOverrides, stableAssetRefsForProjection, reportCityScene, type CityProjectionV1 } from "./data/provider";
import { createCityBuildingCallHandlers } from "./data/cityBuildingCalls";
import { createCitySquadCallHandlers, ensureCitySquadAssetCrosswalks, importLegacyCityClaimsFromTypedStore, readCitySquadSnapshot } from "./data/citySquadCalls";
import { dispatchEntityChanged, ENTITY_CHANGED_EVENT, parseEntityChanged } from "./engine/entityEvents";
import { entityChangedFromBuilding } from "./engine/sessionKitConstruction";
import { SquadFeed } from "./SquadFeed";
import {
  applySquadEnvelope, claimsFromRows, emptyFeed, expireClaims, parseSquadEnvelope, SQUAD_EVENT,
  type SquadFeedState,
} from "./engine/squadEvents";
import "./city.css";
import { embedded, connect, connectHostCalls, invokeHost, observeHealth, noteBusy, publishToolbar, type Tool } from "./host";
import type { EngineQualityMode } from "./engine/CityEngine";
import { CityExperience, useCityExperience } from "./CityExperience";
import { usePlanRepair } from "./planRepair/usePlanRepair";
import { CityMinimap } from "./minimap/CityMinimap";
import { supportsBackgroundFilm } from "./export/filmJob";
import { cityText, cityView, useCityLanguage } from "./i18n";
import { replayStartMs } from "./replayRange";
import { useCityGame } from "./game/useCityGame";
import { MechaBoard, type MechaAvailability } from "./game/MechaBoard";
import { MonsterWorldMarkers } from "./game/MonsterWorldMarkers";
import { encounterIsCurrent, type MonsterEncounter } from "./game/mecha/monsterEncounters";
import { useMonsterEncounters } from "./game/mecha/useMonsterEncounters";
import { prewarmAudioContext } from "./game/GameSfx";
import { CityActivityCoordinator, type CityActivityLease } from "./game/activity/CityActivityCoordinator";
import { useCodeGamePreview } from "./game/codeGameHost/useCodeGamePreview";
import { claimCreatorPlaytest, finishCreatorPlaytest, loadCreatorPublishedMiniGames, pendingCreatorPlaytest, type CreatorPlaytestHandoffV1 } from "./game/activity/loadCreatorExperiences";
import type { PendingCreatorPlaytestV1 } from "./game/activity/creatorPlaytestPending";
import { loadWorldSceneModels } from "./game/activity/creatorSceneModels";
import { resolveCityBoot } from "./game/activity/resolveCityBoot";
import type { PlanPatchV1 } from "./engine/planPatch";
import { createCreatorMiniGamePlan, CreatorMiniGameRuntimeControllerV1, type CreatorPublishedMiniGameV1 } from "./game/activity/creatorMiniGame";
import { playtestOutcome } from "./game/activity/playtestOutcome";
import { m as worldUnits } from "./engine/worldScale";
import { loadCreatorSceneModels } from "./game/activity/creatorSceneModels";
import { createCreatorLayoutSnapshot } from "./engine/sdk/cityLayoutAdapter";
import { useCityDrivingPlay } from "./game/useCityDrivingPlay";
import { ORNITHOPTER_VEHICLE_PRESET_V1 } from "@agent-vitals/city-sdk";
import { createMiamiActivityEntries } from "./game/runtime/miamiActivityEntries";
import { createMiamiGameRuntimeRegistry } from "./game/runtime/miamiActivityHost";
import type { GameRuntimeHandleV1, GameRuntimeRegistryV1, GameRuntimeTelemetryV1, MiamiActivityIdV1 } from "../../../../packages/agent-vitals-city-game-runtime/src/index";
import { DrivingHud } from "./game/DrivingHud";
import type { PlayTarget } from "./engine/render/playableVehicles";
import { useRoadAudit } from "./game/useRoadAudit";
import { RoadAuditPanel } from "./game/ui/RoadAuditPanel";
import type { PlanningWorkSnapshot } from "./engine/planner/operationBudget";
import { projectionSessionRows } from "./viewport/projectionRows";
import { readCityWindowDays, writeCityWindowDays } from "./viewport/windowPreference";
import { createDreamSnapshotCandidate } from "./remote/city/dreamSnapshotCandidate";
import { prepareDreamSnapshotForPublication } from "./remote/city/dreamTrustedProjection";
import type { DreamSnapshotEnvelopeV1 } from "./remote/city/dreamSnapshotCodec";
import type { DreamCitySnapshotV1 } from "./remote/city/dreamSnapshotContract";

const DreamSnapshotPreview = lazy(() => import("./remote/city/DreamSnapshotPreview").then((module) => ({ default: module.DreamSnapshotPreview })));

declare global {
  interface Window {
    __AV_CITY_PROBE__?: () => Record<string, unknown>;
    __AV_CITY_SET_HOVERED__?: (id: string | null) => void;
    __AV_CITY_SELECT__?: (id: string | null) => void;
    __AV_CITY_REPLAY_BUILD__?: (assetOrSession?: string) => boolean;
    __CITY_TYPED_SESSION_ROLLOUT__?: { source?: string; status?: string; reason?: unknown; dataRevision?: number; count?: number; total?: number };
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

type CityBoot = Extract<PendingCreatorPlaytestV1, { pending: true }>;

export function CityApp() {
  const [boot, setBoot] = useState<PendingCreatorPlaytestV1 | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!embedded()) { setBoot({ pending: false }); return; }
    // The host marks the plugin ready after the first toolbar publication.
    // Keep health reporting active while the engine is gated.
    publishToolbar([]);
    const stopHealth = observeHealth();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void resolveCityBoot(pendingCreatorPlaytest,
      () => new Promise<void>(resolve => { timer = setTimeout(resolve, 300); }),
      () => cancelled).then(result => {
        if (result && !cancelled) { stopHealth(); setError(false); setBoot(result); }
      }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; if (timer) clearTimeout(timer); stopHealth(); };
  }, [attempt]);
  // 试玩确认发生在投影之前，但这仍是第一帧。加载公告必须和数据读取
  // 用同一套可感知状态（aria-live、标记、进度轨），不能换成另一块无公告的卡片。
  if (!boot) return <section className="city-app"><div className="city-loading" role="status" aria-live="polite"><div className="city-loading-card">
    <div className="city-loading-mark" aria-hidden="true"><span /><span /><span /><i /></div>
    <p className="city-loading-kicker">AGENT CITY</p>
    <h2>{error ? "无法确认试玩状态" : "读取城市数据"}</h2>
    <p>{error ? "无法连接城市服务，请重试。试玩不会使用其他城市继续。" : "正在确认城市与试玩状态…"}</p>
    <div className="city-loading-track" aria-hidden="true"><span /></div>
    {error && <button onClick={() => { setError(false); setAttempt(value => value + 1); }}>重试</button>}
  </div></div></section>;
  return <CityAppRuntime key={boot.pending ? boot.runId : "player-city"} boot={boot.pending ? boot : null}
    onPlaytestFinished={() => setBoot({ pending: false })} />;
}

function CityAppRuntime({ boot, onPlaytestFinished }: { boot: CityBoot | null; onPlaytestFinished: () => void }) {
  const language = useCityLanguage();
  const [worldProfile, setWorldProfile] = useState<CityWorldProfileV1>(() => boot?.city.profile ?? readCityAppearancePreference());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CityEngine | null>(null);
  const [projection, setProjection] = useState<CityProjectionV1 | null>(null);
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null);
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const [windowDays, setWindowDays] = useState<WindowDays>(() => {
    const params = new URLSearchParams(location.search);
    const days = Number(params.get("windowDays"));
    // The browser landing starts with its mock window, avoiding a second full
    // scene build. The native default follows the shared window preference so
    // the Studio viewport rebuilds the same layout after a restart.
    return embedded() && params.get("presentation") === "landing" && windowOptions.includes(days as WindowDays)
      ? days as WindowDays : readCityWindowDays();
  });
  // 窗口偏好同源共享给 Studio 视口；City 改窗口后两边装出同一座布局。
  useEffect(() => { writeCityWindowDays(windowDays); }, [windowDays]);
  const [status, setStatus] = useState("正在载入 City 插槽数据…");
  const [sceneUnavailable, setSceneUnavailable] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [firstModelFrame, setFirstModelFrame] = useState(false);
  const [cityLoad, setCityLoad] = useState<CityLoadState>({ stage: "data", work: null });
  const [quality, setQuality] = useState<EngineQualityMode>("auto");
  const cityWorldProfileApplyAllowed = useRef(false);
  const [labels, setLabels] = useState(true);
  const [cinema, setCinema] = useState(false);
  const [roadAuditOpen, setRoadAuditOpen] = useState(false);
  const [mechaOpen, setMechaOpen] = useState(false);
  const [selectedEncounter, setSelectedEncounter] = useState<MonsterEncounter | null>(null);
  const [mechaAvailability, setMechaAvailability] = useState<"unknown" | MechaAvailability>("unknown");
  const [dreamPreviewOpen, setDreamPreviewOpen] = useState(false);
  const [dreamPreviewBusy, setDreamPreviewBusy] = useState(false);
  const [dreamPreviewError, setDreamPreviewError] = useState<string | null>(null);
  const [dreamPreviewSnapshot, setDreamPreviewSnapshot] = useState<DreamCitySnapshotV1 | null>(null);
  const [dreamPreviewEnvelope, setDreamPreviewEnvelope] = useState<DreamSnapshotEnvelopeV1 | null>(null);
  const [dreamPublicationActive, setDreamPublicationActive] = useState(false);
  const [dreamPreviewPlainBytes, setDreamPreviewPlainBytes] = useState<number | null>(null);
  const [dreamPreviewEnvelopeBytes, setDreamPreviewEnvelopeBytes] = useState<number | null>(null);
  const dreamPreviewRequest = useRef(0);
  useEffect(() => () => { dreamPreviewRequest.current += 1; }, []);
  const activityCoordinatorRef = useRef<CityActivityCoordinator | null>(null);
  if (!activityCoordinatorRef.current) activityCoordinatorRef.current = new CityActivityCoordinator();
  const activityCoordinator = activityCoordinatorRef.current;
  const mechaActivityLease = useRef<CityActivityLease | null>(null);
  const reportMechaAvailability = useCallback((next: MechaAvailability) => {
    setMechaAvailability((prev) => prev === next ? prev : next);
  }, []);
  const sceneStageReported = useRef(new Set<string>());
  // 每个阶段结束时上报「距上一阶段」的耗时，同时带「距本次加载开始」的累计值。
  // 旧实现直接传 performance.now()，字段名叫 elapsed_ms 实际却是页面绝对时间。
  const stageStartedAt = useRef(performance.now());
  const loadStartedAt = useRef(stageStartedAt.current);
  const reportSceneStage = useCallback((stage: "model" | "planning" | "mounting" | "rendering" | "first_frame", windowDays: WindowDays) => {
    if (sceneStageReported.current.has(stage)) return;
    const now = performance.now();
    const sinceLoad = Math.max(0, now - loadStartedAt.current);
    const elapsed = Math.max(0, now - stageStartedAt.current);
    stageStartedAt.current = now;
    // 只有真正送达宿主才记为已上报；旧实现先 set 再发，早期阶段发送失败就永久丢失。
    void reportCityScene(stage, elapsed, windowDays, sinceLoad).then((sent) => {
      if (sent) sceneStageReported.current.add(stage);
    });
  }, []);
  const mechaActive = useRef(false);
  mechaActive.current = mechaOpen;
  const [refresh, setRefresh] = useState(0);
  const experience = useCityExperience(engineRef, projection, worldProfile, boot?.city.seed);
  const [creatorExperiences, setCreatorExperiences] = useState<readonly CreatorPublishedMiniGameV1[]>([]);
  const [creatorPlaytest, setCreatorPlaytest] = useState<CreatorPlaytestHandoffV1 | null>(null);
  const [playtestError, setPlaytestError] = useState<string | null>(null);
  const [worldSceneReady, setWorldSceneReady] = useState(() => !boot?.worldPackage);
  useEffect(() => {
    if (!boot?.worldPackage) { setWorldSceneReady(true); return; }
    setWorldSceneReady(false);
    if (!firstModelFrame || !boot.worldScene || !engineRef.current) return;
    const engine = engineRef.current;
    let cancelled = false;
    let mounted: Awaited<ReturnType<typeof loadWorldSceneModels>> | null = null;
    void loadWorldSceneModels(boot.worldScene.scene, boot.worldScene.assets, boot.worldScene.files).then(runtime => {
      if (cancelled || engineRef.current !== engine) { runtime.dispose(); return; }
      mounted = runtime;
      if (runtime.group.children.length) engine.addOverlay(runtime.group);
      setWorldSceneReady(true);
    }).catch(() => {
      if (!cancelled) setPlaytestError("试玩城市资产加载失败。为保护发布版本，City 未启动该试玩。");
    });
    return () => {
      cancelled = true;
      if (!mounted) return;
      engine.removeOverlay(mounted.group);
      mounted.dispose();
    };
  }, [boot, firstModelFrame, worldProfile]);
  useEffect(() => {
    setCreatorExperiences([]); setCreatorPlaytest(null);
    if (!firstModelFrame || !embedded() || (boot?.worldPackage && !worldSceneReady)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const load = async () => {
      const view = engineRef.current?.getCitySdkLayoutView();
      if (!view) return;
      if (boot && view.worldRevision !== boot.worldRevision) {
        if (attempts < 30) { attempts += 1; timer = setTimeout(() => { void load(); }, 400); }
        else setPlaytestError("试玩城市布局与发布版本不一致，请返回 Studio 取消并重新发布。");
        return;
      }
      try {
        const handoff = await claimCreatorPlaytest(view, boot?.runId);
        if (handoff) {
          if (!cancelled) { setCreatorPlaytest(handoff); setCreatorExperiences(handoff.experiences); }
          return;
        }
        if (boot) { if (!cancelled) setPlaytestError("试玩已失效，请返回 Studio 检查此次试玩。"); return; }
        const items = await loadCreatorPublishedMiniGames(view);
        if (!cancelled) setCreatorExperiences(items);
      } catch (error) {
        if (!cancelled && boot) setPlaytestError("试玩启动失败，请返回 Studio 检查或取消此次试玩。");
        if (!cancelled && attempts < 5 && error instanceof Error && ["creator_layout_not_found", "plugin_call_timeout", "plugin_call_expired"].includes(error.message)) {
          attempts += 1;
          timer = setTimeout(() => { void load(); }, attempts * 500);
        }
      }
    };
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [firstModelFrame, experience.seed, worldProfile, boot, worldSceneReady]);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !firstModelFrame || !embedded() || !creatorExperiences.length) return;
    let cancelled = false;
    let mounted: Awaited<ReturnType<typeof loadCreatorSceneModels>> | null = null;
    void loadCreatorSceneModels(creatorExperiences).then(runtime => {
      if (cancelled) { runtime.dispose(); return; }
      mounted = runtime;
      if (runtime.group.children.length) engine.addOverlay(runtime.group);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (!mounted) return;
      engine.removeOverlay(mounted.group);
      mounted.dispose();
    };
  }, [creatorExperiences, firstModelFrame, worldProfile]);
  const publishedCreatorLayouts = useRef(new Set<string>());
  useEffect(() => {
    if (boot || !firstModelFrame || !embedded()) return;
    let cancelled = false;
    let frame = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let publishRetries = 0;
    const publishWhenReady = async () => {
      if (cancelled) return;
      const view = engineRef.current?.getCitySdkLayoutView();
      if (!view) {
        attempts += 1;
        if (attempts < 300) frame = requestAnimationFrame(() => { void publishWhenReady(); });
        return;
      }
      if (publishedCreatorLayouts.current.has(view.worldRevision)) return;
      const instanceId = (window as Window & { __AV_PLUGIN_INSTANCE__?: string }).__AV_PLUGIN_INSTANCE__;
      if (!instanceId) {
        attempts += 1;
        if (attempts < 300) frame = requestAnimationFrame(() => { void publishWhenReady(); });
        return;
      }
      const snapshot = createCreatorLayoutSnapshot(view);
      try {
        const response = await invokeHost<{ ok: boolean; result?: unknown }>("plugin_request", { request: {
          version: 1, instanceId, requestId: `city-layout:${view.worldRevision.slice(0, 32)}`,
          method: "city.creator.layout.publish", payload: snapshot,
        } });
        if (!cancelled && response.ok) {
          publishedCreatorLayouts.current.add(view.worldRevision);
          // 补丁随布局发布一起进入 creator 服务（切片 2 的导入源，按 seed+摘要幂等）。
          // 补丁编辑不改变 worldRevision，这里的保证是「布局发布时补丁是新的」；
          // 修复会话保存后自动续发在下一增量接入。
          const patch = engineRef.current?.planPatch;
          if (patch) {
            void invokeHost<{ ok: boolean }>("plugin_request", { request: {
              version: 1, instanceId, requestId: `city-patch:${view.worldRevision.slice(0, 24)}:${Date.now()}`,
              method: "city.creator.patch.publish", payload: { seed: patch.seed, patch },
            } }).catch(() => {});
          }
        }
        else if (!cancelled && publishRetries < 5) {
          publishRetries += 1;
          retryTimer = setTimeout(() => { void publishWhenReady(); }, publishRetries * 500);
        }
      } catch {
        if (!cancelled && publishRetries < 5) {
          publishRetries += 1;
          retryTimer = setTimeout(() => { void publishWhenReady(); }, publishRetries * 500);
        }
      }
    };
    frame = requestAnimationFrame(() => { void publishWhenReady(); });
    return () => { cancelled = true; cancelAnimationFrame(frame); if (retryTimer) clearTimeout(retryTimer); };
  }, [firstModelFrame, experience.seed, worldProfile, boot]);
  const sessionCount = projection?.sessions.length ?? 0;
  // 换种子或会话规模后战场目录作废。空目录会把门禁留下，这里先放开，等下一次搜索再锁。
  useEffect(() => { setMechaAvailability("unknown"); }, [experience.seed, sessionCount]);
  // 飞机与汽车共用宿主运行时；当前城市的自由驾驶从工具栏进入。
  // 必须先于引擎创建 effect 声明——卸载清理时先退出游戏（归还相机）再销毁引擎。
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const cinemaRef = useRef(cinema);
  cinemaRef.current = cinema;
  const mechaOpenRef = useRef(false);
  const miamiRuntimeRegistry = useRef<GameRuntimeRegistryV1 | null>(null);
  const miamiHandles = useRef<Partial<Record<MiamiActivityIdV1, GameRuntimeHandleV1>>>({});
  /** 扑翼原型入口的 typeId 传递（消费后即清空；见 flight command 的 enter）。 */
  const requestedFlightTypeRef = useRef<string | null>(null);
  const filmRef = useRef(!!experience.film);
  filmRef.current = !!experience.film;
  const busyRef = useRef(experience.busy);
  busyRef.current = experience.busy;
  const drivingActive = useRef(false);
  const planRepairActive = useRef(false);
  /** 飞行试玩的结局接线：每次试玩重建，会话只通过这个 ref 回调（不重建 GameSession）。 */
  const flightOutcomeRef = useRef<((status: "success" | "failure" | "error", reason: string | null) => void) | null>(null);
  const game = useCityGame(engineRef, {
    cinemaActive: () => cinemaRef.current,
    filmActive: () => filmRef.current,
    busy: () => busyRef.current || drivingActive.current || mechaActive.current,
    labelsVisible: () => labelsRef.current,
    requestRefresh: () => setRefresh((value) => value + 1),
    locale: () => (language === "en" ? "en" : "zh-Hans"),
    activityCoordinator,
  }, { onCreatorOutcome: (status, reason) => flightOutcomeRef.current?.(status, reason) });
  const gameRef = useRef(game);
  gameRef.current = game;
  const [finishRetry, setFinishRetry] = useState<Parameters<typeof finishCreatorPlaytest> | null>(null);
  const finishPlaytest = useCallback(async (...args: Parameters<typeof finishCreatorPlaytest>) => {
    try {
      await finishCreatorPlaytest(...args);
      setFinishRetry(null);
      setCreatorPlaytest(null);
      setCreatorExperiences([]);
      if (boot) onPlaytestFinished();
    } catch {
      setFinishRetry(args);
      setStatus("试玩结果未能保存，请重试。");
    }
  }, [boot, onPlaytestFinished]);
  const driving = useCityDrivingPlay(engineRef, {
    cinemaActive: () => cinemaRef.current,
    gameActive: () => game.active,
    busy: () => busyRef.current || filmRef.current || planRepairActive.current || mechaActive.current,
    activityCoordinator,
  }, { creatorExperiences, ...(creatorPlaytest?.view ? { playtestView: creatorPlaytest.view } : {}),
    playtestContext: creatorPlaytest ? { runId: creatorPlaytest.runId, releaseId: creatorPlaytest.releaseId,
    projectId: creatorPlaytest.projectId, revision: creatorPlaytest.revision, snapshotDigest: creatorPlaytest.snapshotDigest } : undefined, finishPlaytest });
  const drivingRef = useRef(driving);
  drivingRef.current = driving;
  // Dev-only Code Game 预览入口：?codeGame=<bundle.js>&codeGameManifest=<manifest.json>。
  // 走与 Studio/MCP 预览相同的 production 路径（会话/场景租约/实时世界投影）；
  // 仅 P0 可信本地构建可用，绝不复用于社区下载代码。
  const codeGamePreview = useCodeGamePreview({ engineRef, coordinator: activityCoordinator });
  const codeGamePreviewRequested = useRef(false);
  const startCodeGamePreview = codeGamePreview.start;
  useEffect(() => {
    if (!import.meta.env.DEV || codeGamePreviewRequested.current) return;
    const params = new URLSearchParams(location.search);
    const bundleUrl = params.get("codeGame");
    const manifestUrl = params.get("codeGameManifest");
    if (!bundleUrl || !manifestUrl) return;
    codeGamePreviewRequested.current = true;
    void (async () => {
      // The URL param can arrive before the generator has produced a layout;
      // wait for the engine instead of failing the first frame.
      for (let attempt = 0; attempt < 240 && !codeGamePreview.ready(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!codeGamePreview.ready()) throw new Error("City layout did not become ready for the code game preview");
      const [bundleResponse, manifestResponse] = await Promise.all([fetch(bundleUrl), fetch(manifestUrl)]);
      if (!bundleResponse.ok || !manifestResponse.ok) throw new Error("code game preview assets are unavailable");
      await startCodeGamePreview({
        bundleText: await bundleResponse.text(),
        manifest: await manifestResponse.json(),
        seed: 7,
        assetBaseUrl: new URL(".", new URL(bundleUrl, location.href)).href,
      });
    })().catch((error) => {
      codeGamePreviewRequested.current = false;
      console.error("code game preview failed", error);
    });
  }, [codeGamePreview, startCodeGamePreview]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const holder = window as unknown as { __ohAgentCodeGame?: unknown };
    holder.__ohAgentCodeGame = {
      start: codeGamePreview.start,
      stop: codeGamePreview.stop,
      status: codeGamePreview.status,
      telemetry: codeGamePreview.telemetry,
      ready: codeGamePreview.ready,
      state: codeGamePreview.state,
    };
    return () => {
      delete holder.__ohAgentCodeGame;
    };
  }, [
    codeGamePreview.start,
    codeGamePreview.stop,
    codeGamePreview.status,
    codeGamePreview.telemetry,
    codeGamePreview.ready,
    codeGamePreview.state,
  ]);
  const startedCreatorPlaytest = useRef<string | null>(null);
  useEffect(() => {
    if (!creatorPlaytest || creatorPlaytest.gameType === "flight" || !firstModelFrame || driving.active || startedCreatorPlaytest.current === creatorPlaytest.runId) return;
    const first = creatorPlaytest.experiences[0];
    if (!first) { void finishPlaytest(creatorPlaytest.runId, "failed", undefined, "creator_playtest_experience_unavailable"); return; }
    startedCreatorPlaytest.current = creatorPlaytest.runId;
    driving.startCreatorGame(first.releaseId, first.mount.mountId);
  }, [creatorPlaytest, firstModelFrame, driving.active, driving.startCreatorGame]);
  // flight 试玩 handoff（2026-11-15 泛化切片）：按 gameType 路由到飞行会话；
  // driving 分支完全不经过这里（逐位不变）。飞行试玩证据（visual evidence 与
  // creator pack 规则的映射）属下一切片——本切片在飞行会话退出/失败时以
  // cancelled 收口，避免占用唯一活跃试玩槽直到 TTL。
  const startedFlightPlaytest = useRef<string | null>(null);
  useEffect(() => {
    if (!creatorPlaytest || creatorPlaytest.gameType !== "flight") return;
    const runId = creatorPlaytest.runId;
    if (game.active) { startedFlightPlaytest.current = runId; return; }
    if (startedFlightPlaytest.current !== runId) return;
    const phase = game.snapshot?.controller.phase;
    if (phase === "preparing" && !game.snapshot?.controller.error) return;
    startedFlightPlaytest.current = null;
    void finishPlaytest(runId, "cancelled");
  }, [creatorPlaytest, game.active, game.snapshot, finishPlaytest]);
  useEffect(() => {
    if (!creatorPlaytest || creatorPlaytest.gameType !== "flight" || !firstModelFrame || game.active || startedFlightPlaytest.current === creatorPlaytest.runId) return;
    const runId = creatorPlaytest.runId;
    const experience = creatorPlaytest.experiences[0];
    // 用 claim 合并过发布锚点的那份视图：实机视图只有路网锚点，建计划会 anchor_not_found。
    const view = creatorPlaytest.view ?? engineRef.current?.getCitySdkLayoutView();
    if (!experience || !view) { void finishPlaytest(runId, "failed", undefined, "creator_playtest_experience_unavailable"); return; }
    // 门与规则都来自发布快照：门 = mount 绑定的 fly 锚点（触发半径即环半径），
    // 判定交给 SDK 共享规则执行器（与驾驶同一份），这里不重解释规则。
    const plan = createCreatorMiniGamePlan(view, experience, { capability: "fly" });
    if (!plan.ok) { void finishPlaytest(runId, "failed", undefined, plan.diagnostics[0]?.code ?? "creator_game_plan_invalid"); return; }
    const controller = new CreatorMiniGameRuntimeControllerV1(plan.value, () => {});
    const gates = Object.values(plan.value.zones).flat().map(zone => ({ x: worldUnits(zone.x), y: worldUnits(zone.y), z: worldUnits(zone.z), radius: worldUnits(zone.radius) }));
    flightOutcomeRef.current = (status, reason) => {
      flightOutcomeRef.current = null;
      const outcome = playtestOutcome(status, reason);
      void finishPlaytest(runId, outcome.status,
        controller.visualEvidence(creatorPlaytest.releaseId, creatorPlaytest.revision, creatorPlaytest.snapshotDigest), outcome.failureCode);
    };
    startedFlightPlaytest.current = runId;
    // 飞行试玩飞 release 冻结的那台 profile（物理/相机/包围盒全部来自发布快照）；
    // 旧 release 没有载具 → undefined，退回默认飞机（与本次切片之前的行为一致）。
    void game.enterRace(creatorPlaytest.vehicle, { controller, gates });
  }, [creatorPlaytest, firstModelFrame, game.active, game.enterRace, finishPlaytest]);
  useEffect(() => () => { mechaActivityLease.current?.release(); mechaActivityLease.current = null; }, []);
  drivingActive.current = driving.active;
  // 规划修复（开发开关 ?cityPlan / cityPlanDev=1；未开启时 hook 什么都不做）。与游戏/航拍/导出/忙碌互斥。
  const planRepair = usePlanRepair(engineRef, { seed: experience.seed, model: experience.model, blocked: !!boot || cinema || game.active || driving.active || mechaOpen || experience.busy || !!experience.film });
  // World entries, road audit and Dream preview require the same idle scene.
  // Keep the order used by the Mecha refusal messages.
  const sceneActivityBlocker = cinema ? "cinema"
    : game.active ? "flight"
    : driving.active ? "driving"
    : experience.film ? "film"
    : planRepair.state.active ? "repair"
    : experience.busy ? "busy"
    : mechaOpen ? "mecha"
    : null;
  cityWorldProfileApplyAllowed.current = !boot && !!engineRef.current && firstModelFrame && sceneActivityBlocker === null;
  // Require a modelled city: the board is a view of the current layout, not a game
  // that can start against a half-built scene.
  const exitMecha = () => {
    mechaActivityLease.current?.release(); mechaActivityLease.current = null; setMechaOpen(false);
  };
  const openMecha = (encounter: MonsterEncounter | null = null) => {
    if (sceneActivityBlocker === "mecha") return;
    if (sceneActivityBlocker !== null) {
      const reason = {
        cinema: "航拍进行中，没有进入机甲战，镜头没有锁到地标。",
        flight: "飞行中，没有进入机甲战，镜头没有锁到地标。",
        driving: "驾驶中，没有进入机甲战，镜头没有锁到地标。",
        film: "视频导出进行中，没有进入机甲战，镜头没有锁到地标。",
        repair: "正在修复城市，没有进入机甲战，镜头没有锁到地标。",
        busy: "城市还在忙，没有进入机甲战，镜头没有锁到地标。",
      }[sceneActivityBlocker];
      experience.setError(cityText(reason, language));
      return;
    }
    const engine = engineRef.current;
    if (!engine?.currentLayout || !engine.currentModel) {
      experience.setError(cityText("城市还没准备好，没有进入机甲战，镜头没有锁到地标。", language));
      return;
    }
    if (encounter && !encounterIsCurrent(encounter, engineRef.current?.currentLayout ?? null, engineRef.current?.currentModel ?? null)) {
      experience.setError(language === "en" ? "The city changed. Select an encounter again." : "城市布局已变化，请重新选择遭遇点。");
      return;
    }
    const admission = activityCoordinator.tryAcquire("mecha");
    if (!admission.ok) {
      experience.setError(cityText(`当前${admission.active.activityId}活动正在${admission.active.phase === "preparing" ? "准备" : "运行"}，暂不能进入机甲战。`, language));
      return;
    }
    mechaActivityLease.current = admission.lease;
    admission.lease.activate();
    setSelectedEncounter(encounter);
    experience.setError(null);
    experience.setOptions(false);
    experience.clearSelection();
    setMechaOpen(true);
  };
  mechaOpenRef.current = mechaOpen;
  const openMechaRef = useRef(openMecha);
  openMechaRef.current = openMecha;
  const enterMiamiCinema = () => {
    const engine = engineRef.current;
    experience.clearSelection(); experience.live();
    if (!engine?.startCinematic(experience.cut)) throw new Error("cinema_unavailable");
    setCinema(true);
  };
  const exitMiamiCinema = () => {
    const engine = engineRef.current;
    engine?.stopCinematic(); engine?.setLabelsVisible(labels); setCinema(false);
  };
  const playRef = useRef<(target: PlayTarget) => void>(() => {});
  playRef.current = (target) => {
    if (target.kind === "mecha") { openMecha(); return; }
    if (sceneActivityBlocker !== null) return;
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
  const [squadOpen, setSquadOpen] = useState(false);
  const [squadNow, setSquadNow] = useState(() => Date.now());
  useEffect(() => () => { geographyAbort.current?.abort(); }, []);
  useEffect(() => observeHealth(() => engineRef.current?.diagnosticState() ?? { engineMissing: true }), []);
  useEffect(() => connectHostCalls({
    ...createCitySquadCallHandlers({
      projection: () => projectionRef.current,
      onEnvelope: (envelope) => window.dispatchEvent(new CustomEvent(SQUAD_EVENT, { detail: envelope })),
    }),
    ...createCityBuildingCallHandlers({ projection: () => projectionRef.current }),
    ...createCityWorldProfileCallHandlers({
      instanceId: () => window.__AV_PLUGIN_INSTANCE__ ?? null,
      canApply: () => cityWorldProfileApplyAllowed.current,
      onApplied: (profile) => { setFirstModelFrame(false); setWorldProfile(profile); },
    }),
  }), []);
  useEffect(() => {
    const invalidated = () => setRefresh((value) => value + 1);
    window.addEventListener("__AV_PLUGIN_INVALIDATED__", invalidated);
    return () => window.removeEventListener("__AV_PLUGIN_INVALIDATED__", invalidated);
  }, []);
  useEffect(() => {
    const onHostEvent = (event: Event) => {
      const envelope = (event as CustomEvent).detail as { version?: unknown; source?: unknown; payload?: unknown } | null;
      if (!envelope || envelope.version !== 1 || envelope.source !== "host") return;
      if (parseEntityChanged(envelope.payload)) {
        window.dispatchEvent(new CustomEvent(ENTITY_CHANGED_EVENT, { detail: envelope.payload }));
        return;
      }
      if (parseSquadEnvelope(envelope.payload)) {
        window.dispatchEvent(new CustomEvent(SQUAD_EVENT, { detail: envelope.payload }));
      }
    };
    window.addEventListener("__AV_PLUGIN_EVENT__", onHostEvent);
    return () => window.removeEventListener("__AV_PLUGIN_EVENT__", onHostEvent);
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
    if (!embedded()) return;
    let active = true;
    void readCitySquadSnapshot().then(({ events, claims }) => {
      if (!active) return;
      for (const envelope of events) window.dispatchEvent(new CustomEvent(SQUAD_EVENT, { detail: envelope }));
      for (const claim of claims) {
        const alreadyRestored = events.some((event) => event.kind === "claim" && event.payload.asset_ref === claim.asset_ref
          && event.payload.expires_at === claim.expires_at);
        if (alreadyRestored) continue;
        window.dispatchEvent(new CustomEvent(SQUAD_EVENT, { detail: {
          v: 1, id: `evt_restore_${claim.asset_ref}_${claim.updated_at}`, ts: claim.updated_at, session_id: claim.session_id,
          agent_id: claim.agent_id, agent_name: claim.agent_name, kind: "claim",
          payload: { asset_ref: claim.asset_ref, expires_at: claim.expires_at },
        } }));
      }
    }).catch(() => {});
    return () => { active = false; };
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
    if (boot) { setDataLoaded(true); return; }
    let active = true;
    const loading = new AbortController();
    // 新窗口/刷新 = 新的一次加载：阶段集合与时间线都重新开始。
    sceneStageReported.current.clear();
    loadStartedAt.current = performance.now();
    stageStartedAt.current = loadStartedAt.current;
    setStatus("正在更新 City 插槽数据…");
    const apply = (data: CityProjectionV1, paging = false) => {
      setProjection(data);
      setLoadErrorCode(null);
      setDataLoaded(true);
      setCityLoad({ stage: "model", work: null });
      reportSceneStage("model", data.window.days);
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
      const reason = window.__CITY_TYPED_SESSION_ROLLOUT__?.reason;
      setLoadErrorCode(typeof reason === "string" && /^[a-z0-9_:-]{1,80}$/i.test(reason)
        ? reason : "typed_city_projection_unavailable");
      // Keep a city that already rendered; packaged v3 fallback happens inside the provider.
      setProjection((current) => current ?? null);
      setStatus((current) => current === "正在载入 City 插槽数据…" || current === "正在更新 City 插槽数据…"
        || current === "正在读取全窗口统计…" || current === "正在读取会话建筑…" || !current
        ? "City 数据暂不可用" : current);
    });
    return () => { active = false; loading.abort(); };
  }, [windowDays, refresh, boot]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: CityEngine;
    setFirstModelFrame(false);
    try {
      engine = new CityEngine({ canvas, worldProfile, ...experience.callbacks, onPlay: (target) => playRef.current(target), onFirstFrame: () => { if (!boot) setFirstModelFrame(true); }, onCinematic: (_elapsed, _plan, ended) => {
        experience.callbacks.onCinematic(_elapsed, _plan, ended);
        if (ended) { setCinema(false); }
      } });
      if (boot) engine.setSeed(boot.city.seed);
    } catch {
      setSceneUnavailable(true);
      return;
    }
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [worldProfile]);

  useEffect(() => {
    if (!firstModelFrame || !projection || !embedded()) return;
    reportSceneStage("first_frame", projection.window.days);
  }, [firstModelFrame, projection, reportSceneStage]);

  useEffect(() => {
    // A match reads the live layout for battlefield generation. Deferring City
    // replans while the board is open keeps the snapshot the match was built from
    // stable; the latest projection is applied when the board closes.
    // A pending geography job must not mount an old model while a seed change
    // is being prepared. Clearing the key makes the latest model retry afterwards.
    if (experience.seedBusy && geographyAbort.current) {
      geographyAbort.current.abort();
      geographyAbort.current = null;
      geographyKey.current = "";
    }
    if ((!projection && !boot) || !engineRef.current || experience.busy || game.active || driving.active || mechaOpen) return;
    const engine = engineRef.current;
    const from = projection ? Date.parse(projection.window.from) : 0;
    const to = projection ? Date.parse(projection.window.to) : 1;
    setCityLoad({ stage: "model", work: null });
    const rows = projection ? projectionSessionRows(projection) : [];
    const model = boot ? buildIndependentCityModel() : buildCityModel({
      harnessNames: Object.fromEntries(projection!.harnesses.map((h) => [h.id, h.display_name])),
      rows,
      findings: projection!.findings.map((finding) => ({
        harness: finding.harness,
        rule: "harness_summary",
        severity: finding.severity,
        status_rollup: { open: finding.count, later: 0 },
      })),
      windowStartMs: replayStartMs(projection!.sessions, from, to),
      windowEndMs: to,
      windowLabel: projection!.window.label,
      totalSessions: projection!.coverage.total,
      truncated: projection!.coverage.truncated,
      generatedAt: Date.parse(projection!.generated_at ?? new Date().toISOString()),
    });
    experience.modelRef.current = model;
    experience.setModel(model);
    // Geography is keyed by window + planned population, not the sessions array.
    // Occupant-only page updates must not abort the in-flight island plan or hide the first frame.
    const planned = boot ? 0 : Math.min(4000, Math.max(projection!.sessions.length, projection!.coverage.total));
    const geography = JSON.stringify([boot ? "independent-empty-city" : projection!.window, experience.seed, planned]);
    const occupants = boot ? "" : projection!.sessions.map((session) => session.id).join("\0");
    const signature = `${geography}|${occupants}|${JSON.stringify(boot ? [] : projection!.findings)}`;
    if (signature === fingerprint.current) { experience.refreshSelection(); return; }
    if (geographyKey.current !== geography) {
      geographyAbort.current?.abort();
      const preparation = new AbortController();
      geographyAbort.current = preparation;
      geographyKey.current = geography;
      fingerprint.current = "";
      setFirstModelFrame(false);
      setCityLoad({ stage: "planning", work: null });
      reportSceneStage("planning", projection?.window.days ?? windowDays);
      void prepareCityWorldLayout(model, experience.seed, worldProfile, { signal: preparation.signal,
        onPlanningProgress: (snapshot: PlanningWorkSnapshot) => {
          const work = Object.values(snapshot.consumed).reduce((sum, value) => sum + value, 0);
          setCityLoad({ stage: "planning", work });
        } }).then(async () => {
        if (preparation.signal.aborted || engineRef.current !== engine) return;
        setCityLoad({ stage: "mounting", work: null });
        reportSceneStage("mounting", projection?.window.days ?? windowDays);
        await noteBusy(15_000).catch(() => {});
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (preparation.signal.aborted || engineRef.current !== engine) return;
        if (boot) engine.setPlanPatch((boot.city.planPatch ?? null) as PlanPatchV1 | null);
        engine.applyModel(model, false);
        setCityLoad({ stage: "rendering", work: null });
        reportSceneStage("rendering", projection?.window.days ?? windowDays);
        // applyModel synchronously renders the first frame for this model before returning.
        setFirstModelFrame(true);
        appliedWindow.current = projection?.window.days ?? windowDays;
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
    void prepareCityWorldLayout(model, experience.seed, worldProfile, { signal: preparation.signal }).then(async () => {
      if (preparation.signal.aborted || engineRef.current !== engine) return;
      await noteBusy(8_000).catch(() => {});
      if (preparation.signal.aborted || engineRef.current !== engine) return;
      engine.applyModel(model, true);
      fingerprint.current = signature;
      experience.refreshSelection();
    }).catch(() => {});
    experience.refreshSelection();
    return () => preparation.abort();
  }, [projection, experience.busy, experience.seed, worldProfile, game.active, driving.active, firstModelFrame, mechaOpen, boot]);

  useEffect(() => {
    if (!projection || !embedded()) return;
    let active = true;
    const objectRevisions = new Map<string, number>();
    const refs = projection.sessions.map((session) => session.asset_ref).filter((id): id is string => typeof id === "string");
    const applyOverrides = async (animate: boolean) => {
      const stableAssetRefs = stableAssetRefsForProjection(projection);
      const tokensByAsset = new Map(projection.sessions.flatMap((session) => typeof session.asset_ref === "string"
        ? [[session.asset_ref, session.tokens.total] as const] : []));
      const { overrides, objectStates } = await readBuildingOverrides(refs, stableAssetRefs, tokensByAsset);
      if (!active) return;
      const legacyImportReady = await importLegacyCityClaimsFromTypedStore().catch(() => false);
      await ensureCitySquadAssetCrosswalks(projection, stableAssetRefsForProjection(projection)).catch(() => {});
      const legacySquad = legacyImportReady ? await readCitySquadSnapshot().catch(() => null) : null;
      for (const item of objectStates) objectRevisions.set(item.asset_ref, item.state.objectRevision);
      const nowSecs = Math.floor(Date.now() / 1000);
      setSquad((current) => {
        let next = {
          ...current,
          claims: legacyImportReady || Object.keys(current.claims).length
            ? legacySquad ? claimsFromRows(legacySquad.claims, nowSecs) : expireClaims(current.claims, nowSecs)
            : expireClaims(current.claims, nowSecs),
        };
        for (const event of legacySquad?.events ?? []) next = applySquadEnvelope(next, event, nowSecs);
        return next;
      });
      for (const row of overrides) {
        engineRef.current?.applyBuildingChanged(entityChangedFromBuilding({
          asset_ref: row.asset_ref,
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
          const tokensByAsset = new Map(projection.sessions.flatMap((session) => typeof session.asset_ref === "string"
            ? [[session.asset_ref, session.tokens.total] as const] : []));
          const { objectStates } = await readBuildingOverrides(refs,
            stableAssetRefsForProjection(projection), tokensByAsset);
          const genericStateByAsset = new Map(objectStates.map((item) => [item.asset_ref, item.state]));
          for (const [assetRef, state] of genericStateByAsset) {
            const previousRevision = objectRevisions.get(assetRef);
            objectRevisions.set(assetRef, state.objectRevision);
            if (previousRevision === state.objectRevision || (previousRevision === undefined && state.domainRevision === 0)) continue;
            const event = entityChangedFromBuilding({ asset_ref: assetRef, revision: state.domainRevision,
              event_id: `be_generic_${assetRef}_${state.objectRevision}`, kind: state.model ? "set" : "reset",
              source: "generic-object", model: state.model });
            engineRef.current?.applyBuildingChanged(event, true);
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
  const sceneReady = (boot !== null || (dataAvailable && projection.status !== "empty")) && !sceneUnavailable && firstModelFrame;
  const dreamPreviewEnabled = dreamPublicationActive || (embedded() && projection?.source === "local" && sceneReady
    && sceneActivityBlocker === null);
  const openDreamPreview = async () => {
    if (dreamPublicationActive && dreamPreviewSnapshot) { setDreamPreviewOpen(true); return; }
    if (!dreamPreviewEnabled) return;
    const engine = engineRef.current;
    const model = engine?.currentModel;
    const layout = engine?.currentLayout;
    if (!engine || !model || !layout) {
      setDreamPreviewError(cityText("当前城市场景尚未准备完成。", language));
      setDreamPreviewOpen(true);
      return;
    }
    const request = ++dreamPreviewRequest.current;
    setDreamPreviewOpen(true);
    setDreamPreviewBusy(true);
    setDreamPreviewError(null);
    setDreamPreviewSnapshot(null);
    setDreamPreviewEnvelope(null);
    setDreamPreviewPlainBytes(null);
    setDreamPreviewEnvelopeBytes(null);
    experience.setOptions(false);
    try {
      const candidate = createDreamSnapshotCandidate(model, layout, engine.currentBackdrop, engine.captureReturnView());
      const { candidate: projected, envelope } = await prepareDreamSnapshotForPublication(candidate);
      if (dreamPreviewRequest.current !== request) return;
      if (engineRef.current !== engine || engine.currentLayout !== layout || engine.currentModel !== model) {
        setDreamPreviewError(cityText("城市在预览生成期间发生变化，请重新打开预览。", language));
        return;
      }
      const plain = new TextEncoder().encode(JSON.stringify(projected));
      setDreamPreviewSnapshot(projected);
      setDreamPreviewEnvelope(envelope);
      setDreamPreviewPlainBytes(plain.byteLength);
      setDreamPreviewEnvelopeBytes(new TextEncoder().encode(JSON.stringify(envelope)).byteLength);
    } catch (error) {
      if (dreamPreviewRequest.current !== request) return;
      const code = error instanceof Error ? error.message : "";
      setDreamPreviewError(code === "dream_candidate_too_large"
        ? cityText("快照超过当前远程消息预算，未生成可分享的链接。", language)
        : `本机快照校验或压缩失败${/^(?:dream_|invalid_dream_|remote_city_)[a-z0-9_]{1,72}$/.test(code) ? `（${code}）` : ""}，未生成可分享的链接。`);
    } finally {
      if (dreamPreviewRequest.current === request) setDreamPreviewBusy(false);
    }
  };
  const closeDreamPreview = () => {
    dreamPreviewRequest.current += 1;
    setDreamPreviewOpen(false);
    setDreamPreviewBusy(false);
  };
  useEffect(() => {
    if (dreamPreviewOpen && !dreamPreviewEnabled) closeDreamPreview();
  }, [dreamPreviewOpen, dreamPreviewEnabled]);
  const encounterState = useMonsterEncounters(engineRef, sceneReady);
  // The host projection request precedes model/planning progress. Keep the same
  // loading shell visible from the first render, including a slow summary query.
  const cityLoading = !sceneUnavailable && (boot ? !firstModelFrame : (!dataLoaded || (dataAvailable && projection?.status !== "empty" && !firstModelFrame)));
  const roadAuditEnabled = sceneReady && sceneActivityBlocker === null;
  const mechaEntryEnabled = sceneReady && sceneActivityBlocker === null && Boolean(experience.model) && mechaAvailability !== "empty";
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
    { id: "mecha", commandId: "city.mecha", label: "机甲战棋", kind: "button" as const, enabled: mechaEntryEnabled },
  ].map((tool) => ({ ...tool, enabled: tool.enabled && !mechaOpen && (tool.id === "car" || !driving.active) && (!boot || (tool.id === "car" && driving.active)) })).map((tool: { id: string; label: string; options?: Array<{ value: string; label: string }> }) => ({ ...tool, placement: tool.id === "cinema" || tool.id === "game" || tool.id === "car" || tool.id === "mecha" || tool.id === "film" && experience.film ? "primary" : "overflow", label: cityText(tool.label, language), options: tool.options?.map((option) => ({ ...option, label: cityText(option.label, language) })) })) as Tool[];
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
        if (cinema) stopMiamiActivity("cinema"); else void startMiamiActivity("cinema");
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
        if (driving.active) stopMiamiActivity("driving");
        else if (sceneReady) void startMiamiActivity("driving");
        break;
      case "city.mecha":
        if (!mechaEntryEnabled && !mechaOpen) throw new Error("mecha_unavailable");
        if (mechaOpen) stopMiamiActivity("mecha"); else void startMiamiActivity("mecha");
        break;
      case "city.game":
        if (game.active) stopMiamiActivity("flight");
        else void startMiamiActivity("flight");
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
  useEffect(() => { if (toolbarReady) publishToolbar(tools); }, [language, toolbarReady, windowDays, quality, labels, cinema, mechaOpen, roadAuditOpen, sceneReady, sceneUnavailable, game.active, driving.active, planRepair.state.active, experience.busy, experience.film?.frame, experience.film?.total, mechaEntryEnabled]);
  const sceneMessage = sceneUnavailable ? "当前环境无法显示三维城市，仍可查看会话摘要。"
    : !boot && (!dataAvailable || projection.status === "empty") ? status : null;
  if (!miamiRuntimeRegistry.current) {
    const telemetry = (status: GameRuntimeTelemetryV1["status"], reason: string | null = null, counters: Readonly<Record<string, number>> = {}, metrics: Readonly<Record<string, number>> = {}): GameRuntimeTelemetryV1 =>
      ({ status, tick: 0, counters, metrics, reason });
    const entries = createMiamiActivityEntries({
      flight: {
        enter: () => {
          // 扑翼原型入口改由 VehicleProfileV1 preset 驱动（2026-11-15 泛化切片）：
          // registry 的 flight entry 拿不到 typeId，CityApp 把本次请求放进 ref，
          // 命令消费后立即清空；普通 miami.flight-v1 仍走 legacy 入口，行为逐位不变。
          const requested = requestedFlightTypeRef.current;
          requestedFlightTypeRef.current = null;
          return requested?.includes("-prototype-")
            ? gameRef.current.enterVehiclePractice(ORNITHOPTER_VEHICLE_PRESET_V1)
            : gameRef.current.enterPractice();
        },
        exit: () => gameRef.current.exit(), active: () => gameRef.current.active,
        telemetry: () => { const snapshot = gameRef.current.snapshot; return telemetry(gameRef.current.active ? "running" : "ready", snapshot?.controller.error ? "game_runtime_error" : null,
          {}, { speed: snapshot?.telemetry?.speed ?? 0, altitude: snapshot?.telemetry?.altitude ?? 0 }); },
      },
      driving: {
        enter: () => { experience.setOptions(false); experience.clearSelection(); return drivingRef.current.enter(); },
        exit: () => drivingRef.current.exit(), active: () => drivingRef.current.active,
        telemetry: () => telemetry(drivingRef.current.active ? "running" : "ready", null, { completed: drivingRef.current.race?.completed ?? 0 },
          { speed: drivingRef.current.race?.elapsedSeconds ?? 0 }),
      },
      mecha: {
        enter: () => openMechaRef.current(null), exit: () => exitMecha(), active: () => mechaOpenRef.current,
        telemetry: () => telemetry(mechaOpenRef.current ? "running" : "ready"),
      },
      cinema: {
        enter: () => enterMiamiCinema(), exit: () => exitMiamiCinema(), active: () => cinemaRef.current,
        telemetry: () => telemetry(cinemaRef.current ? "running" : "ready"),
      },
    });
    miamiRuntimeRegistry.current = createMiamiGameRuntimeRegistry(entries);
  }

  async function startMiamiActivity(activity: MiamiActivityIdV1, typeId = `miami.${activity}-v1`): Promise<void> {
    const registry = miamiRuntimeRegistry.current;
    if (!registry) { setStatus("游戏运行时尚未就绪。"); return; }
    try {
      if (typeId.includes("-prototype-")) requestedFlightTypeRef.current = typeId;
      const runtime = registry.resolve(typeId, 1);
      const prepared = await runtime.prepare();
      if (!prepared.ok) { setStatus(`无法进入${activity}：${prepared.failure.code}`); return; }
      miamiHandles.current[activity] = prepared.value;
      if (typeId.includes("-prototype-")) setStatus("已进入扑翼飞行原型（preset 驱动）。");
    } catch (error) {
      requestedFlightTypeRef.current = null;
      setStatus(`无法进入${activity}：${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  function stopMiamiActivity(activity: MiamiActivityIdV1): void {
    const handle = miamiHandles.current[activity];
    if (handle) {
      delete miamiHandles.current[activity];
      handle.dispose();
      return;
    }
    // Activities can be exited by Esc/retry panels before the registry handle
    // is installed; keep the old direct exit as a safe fallback.
    if (activity === "flight") gameRef.current.exit();
    else if (activity === "driving") drivingRef.current.exit();
    else if (activity === "mecha") exitMecha();
    else exitMiamiCinema();
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.key.toLowerCase() !== "o" || event.repeat) return;
      if (gameRef.current.active || drivingRef.current.active || mechaOpenRef.current || cinemaRef.current) return;
      event.preventDefault();
      void startMiamiActivity("flight", "creator.flight-ornithopter-prototype-v1");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!game.active) delete miamiHandles.current.flight;
    if (!driving.active) delete miamiHandles.current.driving;
    if (!mechaOpen) delete miamiHandles.current.mecha;
    if (!cinema) delete miamiHandles.current.cinema;
  }, [game.active, driving.active, mechaOpen, cinema]);

  return cityView((
    <section className="city-app" aria-label="Agent City">
      {playtestError && <div role="alert" className="city-playtest-error">{playtestError}</div>}
      {finishRetry && <div role="alert" className="city-playtest-error">试玩结果未保存。 <button onClick={() => { void finishPlaytest(...finishRetry); }}>重试保存</button></div>}
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
      {!embedded() && !mechaOpen && <header className="city-header" aria-hidden={experience.options || undefined}>
        <div className="city-local-toolbar">{tools.map((tool) => tool.kind === "select"
          ? <select key={tool.id} aria-label={tool.label} value={tool.value} disabled={!tool.enabled} onChange={(event) => execute(tool.commandId, event.target.value)}>{tool.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          : <button key={tool.id} disabled={!tool.enabled} onClick={() => execute(tool.commandId)}>{tool.label}</button>)}</div>
      </header>}
      {!boot && !cinema && !game.active && !driving.active && !mechaOpen && sceneReady && <SquadFeed
        items={squad.items} nowMs={squadNow} open={squadOpen} onOpen={setSquadOpen}
        onFocus={(assetRef) => { engineRef.current?.focusBuilding(assetRef); }} />}
      <div hidden={driving.active || mechaOpen}><CityExperience ui={experience} disabled={!sceneReady || !!boot} cinema={cinema} status={status} loadErrorCode={loadErrorCode} quality={quality} theme={engineRef.current?.currentTheme} game={game} planRepair={planRepair}
        windowDays={windowDays} windowOptions={windowOptions} onWindowDays={(days) => setWindowDays(days as WindowDays)} labels={labels} onLabels={(next) => { engineRef.current?.setLabelsVisible(next); setLabels(next); }}
        onQuality={(value) => { if (["auto", "high", "eco"].includes(value)) { engineRef.current?.setQualityMode(value as EngineQualityMode); setQuality(value as EngineQualityMode); } }}
        onMecha={() => openMecha()} mechaEnabled={mechaEntryEnabled} mechaAvailability={mechaAvailability}
        onDreamPreview={() => { void openDreamPreview(); }} dreamPreviewEnabled={dreamPreviewEnabled} dreamPublicationActive={dreamPublicationActive} /></div>
      {(dreamPreviewOpen || dreamPreviewSnapshot || dreamPreviewBusy) && <Suspense fallback={null}><DreamSnapshotPreview open={dreamPreviewOpen} snapshot={dreamPreviewSnapshot} envelope={dreamPreviewEnvelope} plainBytes={dreamPreviewPlainBytes}
        envelopeBytes={dreamPreviewEnvelopeBytes} busy={dreamPreviewBusy} error={dreamPreviewError} onClose={closeDreamPreview}
        onPublicationActive={setDreamPublicationActive} /></Suspense>}
      {dreamPublicationActive && !dreamPreviewOpen && <button type="button" className="dream-manage-remote-fab" onClick={() => { void openDreamPreview(); }}>{cityText("管理远程访问", language)}</button>}
      {mechaOpen && !game.active && !driving.active && !cinema && <MechaBoard locale={language === "en" ? "en" : "zh-Hans"} engine={engineRef.current} encounter={selectedEncounter} onClose={() => {
        mechaActivityLease.current?.release(); mechaActivityLease.current = null; setMechaOpen(false);
      }} onAvailability={reportMechaAvailability} />}
      {sceneActivityBlocker === null && sceneReady && <MonsterWorldMarkers engine={engineRef.current} encounters={encounterState.encounters} language={language} onEnter={openMecha} />}
      {sceneReady && !boot && sceneActivityBlocker === null && (
        <button type="button" className="city-prototype-launch" onClick={() => { void startMiamiActivity("flight", "creator.flight-ornithopter-prototype-v1"); }}>
          扑翼原型
        </button>
      )}
      <CityMinimap engine={engineRef} language={language} driving={{ active: driving.active, pose: driving.pose }} encounters={encounterState}
        creatorGames={driving.creatorGames} onStartCreatorGame={driving.startCreatorGame}
        hidden={!sceneReady || cinema || game.active || mechaOpen || !!experience.film || driving.hud.phase === "preparing" || driving.hud.phase === "error"} />
      <DrivingHud model={{ active: driving.active, choosingVehicle: driving.choosingVehicle, vtol: driving.vtol, activityKind: driving.activityKind, activityTitle: driving.activityTitle, creatorGames: driving.creatorGames, entryError: driving.entryError,
        race: driving.race, raceEntryError: driving.raceEntryError,
        initialPaused: driving.initialPaused, hud: driving.hud, preparationProgress: driving.preparationProgress, events: driving.events, diagnostics: driving.diagnostics(),
        roadCheck: driving.roadCheck }}
        actions={{ selectVehicle: driving.selectVehicle, startRace: driving.startRace, startCollect: driving.startCollect, startCreatorGame: driving.startCreatorGame, clearEntryError: driving.clearEntryError, exit: driving.exit, pause: driving.pause,
          resume: driving.resume, openUiContext: driving.openUiContext }}
        locale={language === "en" ? "en" : "zh-Hans"} sound={driving.sound} />
      {roadAuditEnabled && roadAuditOpen && <RoadAuditPanel snapshot={roadAudit.snapshot} run={() => { void roadAudit.run(); }} cancel={() => roadAudit.cancel()}
        engineRef={engineRef} locale={language === "en" ? "en" : "zh-Hans"} canRun={roadAuditEnabled} history={roadAudit.history} historySaved={roadAudit.historySaved} close={() => setRoadAuditOpen(false)} />}
    </section>
  ), language);
}
