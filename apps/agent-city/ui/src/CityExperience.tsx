import { sessionCostLabel } from "./data/sessionCostLabel";
import { playableKind } from "./engine/render/playableVehicles";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CityModel } from "./cityModel";
import { readCitySessionDetail, type CityProjectionV1 } from "./data/provider";
import { citySeed, randomSeed } from "./data/seed";
import type { CityEngine, EngineStats } from "./engine/CityEngine";
import type { CinematicCard, CinematicCut, CinematicPlan } from "./engine/cityCinematic";
import type { BackdropMode } from "./engine/cityLayout";
import { paletteFor } from "./engine/cityTextures";
import { invokeHost, embedded, pluginLocale } from "./host";
import type { PluginResponseV1 } from "@agent-vitals/app-sdk";
import { runFilmJob, supportsBackgroundFilm } from "./export/filmJob";
import { cinematicCopy } from "./engine/cinematicCopy";
import { describeDecor, isDecorId, decorDistrictId } from "./engine/cityDecor";
import { CATALOG_GROUPS, CATALOG_KIND_LABEL, CITY_CATALOG } from "./cityCatalog";
import { scaleTierFor } from "./engine/cityPlan";
import { PlanRepairPanel } from "./planRepair/PlanRepairPanel";
import type { PlanRepairUi } from "./planRepair/usePlanRepair";
import { cityText, cityView, useCityLanguage } from "./i18n";
import { GameHud } from "./game/GameHud";
import { BuildingBookmark } from "./BuildingBookmark";
import { CityDataFacility } from "./CityDataFacility";
import { CityPanel } from "./CityPanel";
import { CITY_DATA_PLACES, cityDataPlaceForDecor, type CityDataPlaceId } from "./cityDataPlaces";
import { gameText } from "./game/gameCopy";
import { prewarmAudioContext } from "./game/GameSfx";
import type { useCityGame } from "./game/useCityGame";

declare const __CITY_GAME_UAT__: boolean;

const dateLabel = (ms: number) => new Date(ms).toLocaleString(pluginLocale() === "en" ? "en-US" : "zh-CN");
const tokens = (n: number) => n.toLocaleString(pluginLocale() === "en" ? "en-US" : "zh-CN");
const costLabel = (session?: CityProjectionV1["sessions"][number]) => sessionCostLabel(session, pluginLocale() === "en" ? "en" : "zh");
/** 会话标题来源 → 展示名（V32 楼名）。未知来源原样展示，不编造。 */
const titleSourceLabel = (source?: string | null) =>
  source === "codex_thread_name" ? "Codex 线程名"
  : source === "claude_ai_title" ? "Claude AI 标题"
  : source === "dsh_workspace_title" ? "DSH 工作区名"
  : source ?? null;
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function useCityExperience(engine: RefObject<CityEngine | null>, projection: CityProjectionV1 | null) {
  const modelRef = useRef<CityModel | null>(null);
  const [model, setModel] = useState<CityModel | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [orbitLocked, setOrbitLocked] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [options, setOptions] = useState(false);
  const [catalog, setCatalog] = useState(false);
  const [seed, setSeed] = useState(74031);
  const [seedDraft, setSeedDraft] = useState("74031");
  const [seedBusy, setSeedBusy] = useState(true);
  const [confirmSeed, setConfirmSeed] = useState(false);
  const seedTimer = useRef<number | undefined>(undefined);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(3600);
  const [cut, setCut] = useState<CinematicCut>("short");
  // 背景楼档位（F4）：按本机浏览器存储（与种子不同，不经宿主 city-settings 投影——那需要宿主侧改动，见 SPEC §4 F4 注）。
  const [backdrop, setBackdropState] = useState<BackdropMode>(() => {
    try { const saved = localStorage.getItem("city.backdrop"); return saved === "auto" || saved === "full" ? saved : "off"; } catch { return "off"; }
  });
  const setBackdrop = (mode: BackdropMode) => {
    setBackdropState(mode);
    try { localStorage.setItem("city.backdrop", mode); } catch { /* 存储不可用：本次会话内仍生效 */ }
  };
  useEffect(() => { engine.current?.setBackdrop(backdrop); }, [backdrop]);
  const [film, setFilm] = useState<{ frame: number; total: number; width?: number; height?: number; software?: boolean } | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [card, setCard] = useState<CinematicCard | null>(null);
  const [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    const suspend = () => { abort.current?.abort(); };
    window.addEventListener("__AV_PLUGIN_SUSPENDED__", suspend);
    return () => window.removeEventListener("__AV_PLUGIN_SUSPENDED__", suspend);
  }, []);
  const requests = useRef(0);
  const mounted = useRef(true);
  const lastCursor = useRef(0);
  const lastCard = useRef<CinematicCard | null>(null);
  const lastProgress = useRef(0);
  const busy = photoBusy || seedBusy;

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void (async () => {
      try {
        const saved = await citySeed("read");
        const value = saved ?? randomSeed();
        if (!active) return;
        if (saved === null) await citySeed("write", value);
        if (!active) return;
        engine.current?.setBackdrop(backdrop); // 首次布局前就用已存档位，避免先按 auto 排一遍再换
        engine.current?.setSeed(value); setSeed(value); setSeedDraft(String(value));
      } catch {
        if (active) { engine.current?.setSeed(74031); setError("岛屿种子无法保存，本次使用临时种子。"); }
      } finally { if (active) setSeedBusy(false); }
    })();
    return () => { active = false; mounted.current = false; abort.current?.abort(); window.clearTimeout(seedTimer.current); };
  }, []);

  const clearSelection = () => { setSelected(null); setDetails(false); engine.current?.setSelected(null); };
  // 区的显示名（ZCode 而不是 harness:zcode）：悬停提示与详情面板共用。
  const districtLabel = (id: string) => modelRef.current?.districts.find((district) => district.id === id)?.label ?? id;
  const callbacks = useMemo(() => ({
    onSelect(id: string | null) { setSelected(id); setDetails(false); },
    onOrbitLock(id: string | null) { setOrbitLocked(id); },
    onHover(id: string | null, x: number, y: number) {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      // 可开的载具：提示「点击开车 / 开飞机」，车带上它所属城区的名字（颜色就是这个城区的 harness 楼色）。
      const play = playableKind(id);
      if (play) {
        const en = pluginLocale() === "en";
        tooltip.textContent = play === "plane" ? (en ? "Plane · click to fly from the runway" : "飞机 · 点击从跑道起飞")
          : play === "mecha" ? (en ? "Mechs · click to start the battle" : "机甲 · 点击进入战斗")
          : `${districtLabel(id!.slice("play:car:".length))} · ${en ? "click to drive from this landmark" : "点击从这座地标出发开车"}`;
        tooltip.style.opacity = "1";
        tooltip.style.transform = `translate(${Math.min(x + 14, Math.max(8, window.innerWidth - 270))}px, ${Math.min(y + 14, window.innerHeight - 60)}px)`;
        return;
      }
      const decor = id && isDecorId(id) ? describeDecor(id) : null;
      const building = decor ? undefined : modelRef.current?.buildings.find((b) => b.id === id);
      if (!building && !decor) { tooltip.style.opacity = "0"; return; }
      if (decor) {
        const locale = pluginLocale();
        tooltip.textContent = `${cityText(decor.title, locale)} · ${cityText(decor.category, locale)}`;
      } else if (building) tooltip.textContent = `${districtLabel(building.districtId)} · ${tokens(building.tokensTotal)} tokens${building.aggregated ? ` · ${building.extraCount}${pluginLocale() === "en" ? " aggregated sessions" : " 个聚合会话"}` : ""}`;
      tooltip.style.opacity = "1";
      tooltip.style.transform = `translate(${Math.min(x + 14, Math.max(8, window.innerWidth - 270))}px, ${Math.min(y + 14, window.innerHeight - 60)}px)`;
    },
    onStats(value: EngineStats) { setStats(value); },
    onTimeCursor(ms: number, live: boolean) {
      const now = performance.now();
      if (!live && now - lastCursor.current < 180) return;
      lastCursor.current = now; setCursor(live ? null : ms); setPlaying(engine.current?.isPlaying ?? false);
    },
    onCinematic(seconds: number, plan: CinematicPlan, ended: boolean) {
      const next = ended ? null : plan.cards.find((c) => seconds >= c.atSec && seconds < c.untilSec) ?? null;
      const p = ended ? 0 : Math.min(1, seconds / plan.durationSec);
      if (next !== lastCard.current || Math.abs(p - lastProgress.current) >= .01 || ended) {
        lastCard.current = next; lastProgress.current = p; setCard(next); setProgress(p);
      }
    },
  }), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (options) setOptions(false);
      else if (details) setDetails(false);
      else if (film) abort.current?.abort();
      else { engine.current?.stopCinematic(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [options, details, film]);

  const applySeed = async (value: number) => {
    if (busy || !Number.isInteger(value) || value < 1 || value > 4294967295) { setError("种子须为 1–4294967295 的整数。"); return; }
    setSeedBusy(true); setError(null);
    try {
      await citySeed("write", value);
      if (!mounted.current) return;
      engine.current?.setSeed(value); setSeed(value); setSeedDraft(String(value)); clearSelection();
    } catch { if (mounted.current) setError("无法保存岛屿种子，原岛屿保持不变。"); }
    finally { if (mounted.current) setSeedBusy(false); }
  };
  const reseed = () => {
    if (!confirmSeed) { setConfirmSeed(true); seedTimer.current = window.setTimeout(() => setConfirmSeed(false), 4000); return; }
    setConfirmSeed(false); window.clearTimeout(seedTimer.current); void applySeed(randomSeed());
  };
  const seek = (value: number) => {
    const model = modelRef.current; if (!model) return;
    const ms = model.windowStartMs + value / 1000 * (model.windowEndMs - model.windowStartMs);
    engine.current?.setTimeCursor(ms, { playing: false }); setCursor(ms); setPlaying(false);
  };
  const replay = () => {
    const model = modelRef.current; if (!model) return;
    const ms = cursor !== null && cursor < model.windowEndMs ? cursor : model.windowStartMs;
    engine.current?.setTimeCursor(ms, { playing: !playing, speed }); setCursor(ms); setPlaying(!playing);
  };
  const live = () => { engine.current?.setTimeCursor(null, { playing: false }); setCursor(null); setPlaying(false); };
  const describe = (c: CinematicCard) => {
    const model = modelRef.current;
    if (!model) return null;
    return cinematicCopy(model, c, pluginLocale());
  };
  const photo = async () => {
    if (!engine.current || busy || abort.current) return;
    setPhotoBusy(true); setError(null);
    try { const blob = await engine.current.capturePhoto({ watermark: "agent-vitals" }); if (mounted.current) download(blob, `agent-city-${Date.now()}.png`); }
    catch { if (mounted.current) setError("拍照失败，当前环境可能不支持画布导出。"); }
    finally { if (mounted.current) setPhotoBusy(false); }
  };
  const exportFilm = async () => {
    if (abort.current) { abort.current.abort(); return; }
    if (!modelRef.current || busy) return;
    setError(null);
    const controller = new AbortController(); abort.current = controller; setFilm({ frame: 0, total: 1 });
    previewRef.current?.getContext("2d")?.clearRect(0, 0, 640, 360);
    try {
      const blob = await runFilmJob({ model: structuredClone(modelRef.current), seed, cut, backdrop, locale: pluginLocale(), width: 1920, height: 1080, fps: 30, bitrate: 12_000_000 }, {
        signal: controller.signal,
        onPreview: (bitmap) => {
          const canvas = previewRef.current;
          if (!mounted.current || !canvas) return;
          const context = canvas.getContext("2d");
          if (context) context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        },
        onProfile: (width, height, software) => { if (mounted.current) setFilm((value) => value ? { ...value, width, height, software } : value); },
        onProgress: (frame, total) => { if (mounted.current) setFilm((value) => value ? { ...value, frame, total } : value); },
      });
      if (mounted.current) download(blob, `agent-city-${cut}-${Date.now()}.${blob.type === "video/webm" ? "webm" : "mp4"}`);
    } catch (reason) {
      if (mounted.current && !(reason instanceof DOMException && reason.name === "AbortError")) {
        const code = reason instanceof Error ? reason.message : "background_export_failed";
        setError(code === "export_memory_limit" ? "视频超过导出内存上限，请改用短片。"
          : code === "background_export_timeout" ? "后台导出无响应，任务已终止；City 可以继续使用。"
          : code === "video_encoder_unavailable" ? "当前环境没有可用的视频编码器（H.264 / VP9 / VP8），可使用拍照。"
          : ["background_export_unavailable", "background_webgl_unavailable"].includes(code)
            ? "当前环境不支持后台视频导出，可使用拍照；不会在界面线程执行导出。"
            : "后台视频导出失败，City 可以继续使用。");
      }
    } finally { abort.current = null; if (mounted.current) setFilm(null); }
  };
  const refreshSelection = () => { if (selected && !isDecorId(selected) && !modelRef.current?.buildings.some((b) => b.id === selected)) clearSelection(); else engine.current?.setSelected(selected); };
  const openHostSession = async () => {
    if (!selected || !embedded() || projection?.source !== "local") { setError("合成会话没有宿主日志详情，请使用原生真实数据模式。"); return; }
    const requestId = `city-open-${++requests.current}`;
    try {
      const response = await invokeHost<PluginResponseV1<{ opened: boolean }>>("plugin_request", { request: {
        version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId, method: "ui.open-session", payload: { handle: selected },
      } });
      if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result?.opened) throw new Error("session_unavailable");
    } catch { if (mounted.current) setError("无法打开宿主会话详情，数据可能已删除或当前实例已失效。"); }
  };
  return { modelRef, model, setModel, tooltipRef, callbacks, selected, setSelected, clearSelection, orbitLocked, releaseOrbitLock: () => engine.current?.releaseOrbitLock(), details, setDetails, options, setOptions, catalog, setCatalog,
    seed, seedDraft, setSeedDraft, seedBusy, confirmSeed, applySeed, reseed, cursor, playing, speed, setSpeed,
    cut, setCut, backdrop, setBackdrop, film, photoBusy, busy, error, setError, stats, card, progress, seek, replay, live, previewRef,
    describe, photo, exportFilm, refreshSelection, openHostSession, projection,
    districtServices: (id: string) => engine.current?.currentLayout?.civics.filter((c) => c.districtId === id).map((c) => c.kind) ?? [],
    serviceDistrict: (id: string | null) => engine.current?.currentLayout?.civics.find((c) => c.id === id?.split("#")[1])?.districtId ?? null,
    focusDistrict: (id: string) => engine.current?.focusDistrict(id),
    focusCatalog: (id: string) => engine.current?.focusCatalog(id) ?? false,
    lockSelection: (id: string) => engine.current?.lockSelection(id) };
}

export function CityExperience({ ui, disabled, cinema, status, quality, onQuality, game, planRepair, windowDays, windowOptions, onWindowDays, labels, onLabels, onMecha, mechaAvailability = "unknown" }: { ui: ReturnType<typeof useCityExperience>; disabled: boolean; cinema: boolean; status?: string; quality: string; onQuality: (value: string) => void; game: ReturnType<typeof useCityGame>; planRepair: PlanRepairUi; windowDays: number; windowOptions: readonly number[]; onWindowDays: (days: number) => void; labels: boolean; onLabels: (next: boolean) => void; onMecha?: () => void; mechaAvailability?: "unknown" | "searching" | "ready" | "empty" | "error" }) {
  const language = useCityLanguage();
  // Presentation only: the landing host still enforces its own fixture/method boundary.
  const landingPreview = embedded() && new URLSearchParams(location.search).get("presentation") === "landing";
  const gameActive = game.active;
  // 游戏接管时收起模态与侧栏（native dialog 在 top layer，会盖住游戏 HUD）。
  useEffect(() => {
    if (!gameActive) return;
    ui.setOptions(false); ui.setDetails(false); ui.setCatalog(false);
  }, [gameActive]);
  // 音频上下文预热：WKWebView 首次 new AudioContext() 可能同步阻塞主线程数秒，
  // 放在进场关键路径会把进入游戏冻结住。城市就绪后的空闲时机先建好（不发声）。
  useEffect(() => {
    if (disabled || !ui.model || landingPreview) return;
    let active = true;
    const warm = () => { if (active) prewarmAudioContext(); };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 4000 });
      return () => { active = false; cancelIdleCallback(id); };
    }
    const timer = setTimeout(warm, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [disabled, ui.model, landingPreview]);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [dataPlace, setDataPlace] = useState<CityDataPlaceId | null>(null);
  const [dataDistrict, setDataDistrict] = useState<string | null>(null);
  const [dataPlaceFromDirectory, setDataPlaceFromDirectory] = useState(false);
  const [dataPlaceFromSelection, setDataPlaceFromSelection] = useState(false);
  const openDataPlace = (id: CityDataPlaceId | null, fromDirectory = false, districtId: string | null = null) => {
    setDataDistrict(districtId);
    setDataPlaceFromDirectory(fromDirectory); setDataPlaceFromSelection(false); setDataPlace(id);
    if (fromDirectory) setSummaryOpen(false);
  };
  // 医院/学校等数据设施：点击直接进数据窗口（一层弹窗）。曾先出说明面板、再点「打开设施数据」才见数据，
  // 用户要多走一步。市政厅自带全城概况面板，不走这里。
  useEffect(() => {
    const place = ui.selected && ui.selected !== "decor:site:civic" && !cinema && !gameActive ? cityDataPlaceForDecor(ui.selected) : null;
    setDataPlaceFromDirectory(false);
    setDataPlaceFromSelection(place !== null);
    setDataDistrict(place && ui.selected ? ui.serviceDistrict(ui.selected) : null);
    setDataPlace(place);
  }, [ui.selected, cinema, gameActive]);
  // 右侧只有一个面板位，下钻是原地替换而不是叠弹窗：数据窗口开着时详情面板让位，「‹ 返回」回到它。
  const dataOpen = dataPlace !== null && !!ui.projection;
  // 建筑说明与建筑面板同占右侧，互斥：说明开着时点了楼 → 说明让位，楼的面板给「返回建筑说明」；
  // 从工具栏打开说明 → 放下当前选中。曾两者同时开着，面板盖在说明上。
  const [catalogReturn, setCatalogReturn] = useState(false);
  useEffect(() => {
    if (!ui.selected) { setCatalogReturn(false); return; }
    if (ui.catalog) { setCatalogReturn(true); ui.setCatalog(false); }
  }, [ui.selected]);
  useEffect(() => { if (ui.catalog && ui.selected) ui.clearSelection(); }, [ui.catalog]);
  const backToCatalog = catalogReturn ? { label: "返回建筑说明", onBack: () => { ui.clearSelection(); ui.setCatalog(true); } } : undefined;
  const [replayOpen, setReplayOpen] = useState(false);
  const summaryButton = useRef<HTMLButtonElement>(null);
  const replayButton = useRef<HTMLButtonElement>(null);
  const timelineRef = useRef<HTMLElement>(null);
  const compact = (n: number) => new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { notation: "compact", maximumFractionDigits: 2 }).format(n);
  const availableProjection = ui.projection?.status === "unavailable" ? null : ui.projection;
  const totalTokens = availableProjection?.summary?.tokens.total ?? availableProjection?.sessions.reduce((sum, session) => sum + session.tokens.total, 0);
  useEffect(() => { if (ui.selected || ui.catalog) setSummaryOpen(false); }, [ui.selected, ui.catalog]);
  useEffect(() => {
    const element = timelineRef.current;
    if (!element) return;
    const update = () => element.closest<HTMLElement>(".city-app")?.style.setProperty("--city-timeline-height", `${element.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, [cinema]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || ui.options || ui.details || ui.film || cinema) return;
      if (summaryOpen) { setSummaryOpen(false); summaryButton.current?.focus(); }
      else if (ui.catalog) ui.setCatalog(false);
      else if (ui.selected) ui.clearSelection();
      else if (replayOpen) { setReplayOpen(false); replayButton.current?.focus(); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [summaryOpen, replayOpen, ui.selected, ui.catalog, ui.options, ui.details, ui.film, cinema]);
  const model = ui.model;
  const selected = model?.buildings.find((b) => b.id === ui.selected);
  const initialSession = ui.projection?.sessions.find((s) => s.id === ui.selected);
  const [loadedDetail, setLoadedDetail] = useState<CityProjectionV1["sessions"][number] | null>(null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const detailRefresh = useRef(false);
  useEffect(() => {
    setLoadedDetail(null); setDetailState("idle");
    if (!ui.details || !initialSession || !ui.projection) { detailRefresh.current = false; return; }
    const request = new AbortController();
    setDetailState("loading");
    void readCitySessionDetail(ui.projection, initialSession.id, request.signal).then((detail) => {
      if (!request.signal.aborted) { setLoadedDetail(detail); setDetailState("ready"); }
    }).catch(() => {
      if (request.signal.aborted) return;
      setDetailState("unavailable");
      if (detailRefresh.current) return;
      detailRefresh.current = true;
      window.dispatchEvent(new Event("__AV_PLUGIN_INVALIDATED__"));
    });
    return () => request.abort();
  }, [ui.details, initialSession?.id, ui.projection]);
  const session = loadedDetail?.id === initialSession?.id ? loadedDetail ?? initialSession : initialSession;
  const card = ui.card ? ui.describe(ui.card) : null;
  const locked = disabled || cinema || ui.busy;
  const decorCamera = <>
    {ui.orbitLocked === ui.selected ? <button onClick={ui.releaseOrbitLock}>解除视角锁定</button>
      : <button disabled={locked} onClick={() => ui.selected && ui.lockSelection(ui.selected)}>锁定视角</button>}
    <p className="city-camera-help">{ui.orbitLocked === ui.selected ? "已锁定目标：左键拖动环绕，滚轮缩放。" : "自由视角：左键环绕，右键平移，滚轮朝指针缩放。"}</p>
    <p className="city-camera-help">点击空白处取消锁定；镜头远近由滚轮控制。</p>
  </>;
  // 建筑说明：非模态侧栏（不用 dialog），飞到实时模型时城市仍可见、可旋转查看；开关在顶部工具栏（city.catalog）。
  const catalog = ui.catalog; const setCatalog = ui.setCatalog;
  const [missing, setMissing] = useState<string | null>(null);
  const slider = !model || ui.cursor === null ? 1000 : Math.max(0, Math.min(1000,
    Math.round((ui.cursor - model.windowStartMs) / Math.max(1, model.windowEndMs - model.windowStartMs) * 1000)));
  const debug = new URLSearchParams(location.search).has("cityDebug");
  const settingsRef = useRef<HTMLDialogElement>(null);
  const detailsRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (ui.options) settingsRef.current?.showModal(); else settingsRef.current?.close(); }, [ui.options]);
  useEffect(() => { if (ui.details && session) detailsRef.current?.showModal(); else detailsRef.current?.close(); }, [ui.details, session?.id]);
  const dataBack = dataPlaceFromDirectory ? { label: "返回城市摘要", onBack: () => { setDataPlace(null); setSummaryOpen(true); } }
    : !dataPlaceFromSelection && ui.selected ? { label: ui.selected === "decor:site:civic" ? "返回市政厅"
      : <>返回 {model?.districts.find((d) => d.id === decorDistrictId(ui.selected))?.label ?? ""}</>, onBack: () => setDataPlace(null) }
    : backToCatalog;
  return cityView(<>
    <div className="city-tooltip" ref={ui.tooltipRef} aria-hidden="true" />
    {!cinema && !gameActive && <button ref={summaryButton} className="city-summary-trigger" aria-label="城市摘要" aria-expanded={summaryOpen} aria-controls="city-summary-panel" onClick={() => { ui.clearSelection(); ui.setCatalog(false); setSummaryOpen(!summaryOpen); }}>
      <span>{availableProjection ? compact(availableProjection.coverage.total) : "—"} 会话 · {totalTokens === undefined ? "—" : compact(totalTokens)} tokens</span>
      {ui.projection?.coverage.truncated && <span className="city-coverage-badge">已截断</span>}
      {ui.projection?.source === "fixture" && <span className="city-coverage-badge">演示</span>}
      <span aria-hidden="true">{summaryOpen ? "−" : "›"}</span>
    </button>}
    {!cinema && !gameActive && summaryOpen && <section id="city-summary-panel" className="city-legend" aria-label="城市摘要">
      <h2>城市摘要</h2>
      <p>{status}</p>
      <dl><dt>已载入会话</dt><dd>{ui.projection?.coverage.returned ?? "—"} / {ui.projection?.coverage.total ?? "—"}</dd>
        <dt>Token</dt><dd>{totalTokens === undefined ? "—" : tokens(totalTokens)}</dd>
        <dt>活跃</dt><dd>{model?.stats.activeCount ?? "—"}</dd>
        <dt>窗口内模型</dt><dd>{ui.projection?.models?.length ? ui.projection.models.join("、") : "无模型标识"}</dd>
        {ui.projection?.activity?.busiest_day && <><dt>最忙的一天</dt><dd>{ui.projection.activity.busiest_day.date} · {ui.projection.activity.busiest_day.session_count} 会话</dd></>}</dl>
      <p>全窗统计包含所有匹配会话；建筑与回放只包含已载入部分。</p>
      <nav className="city-data-places" aria-label="数据设施"><h2>数据设施</h2>
        {CITY_DATA_PLACES.map((place) => <button key={place.id} onClick={() => openDataPlace(place.id, true)}>
          <strong>{language === "en" ? place.englishTitle : place.title}</strong>
          <span>{language === "en" ? place.englishDescription : place.description}</span>
        </button>)}
      </nav>
      <h2>执行环境城区</h2>
      {(model?.districts ?? []).map((district) => <div key={district.id}><button disabled={locked} onClick={() => ui.focusDistrict(district.id)}>
        <span aria-hidden="true" style={{ background: paletteFor(district.id).accent }} /><strong>{district.label}</strong>
        <span className="city-district-meta">{district.sessionCount} 会话 · {district.activeCount} 活跃</span>
        {district.anomaly && <span className="city-district-meta">{district.anomaly.severity} · {district.anomaly.count} 条异常（部分投影）</span>}
      </button><nav className="city-district-services" aria-label={cityText("城区公共服务", language)}>
        <button onClick={() => openDataPlace("findings", true, district.id)}>{district.label} · {cityText("本区诊断中心", language)}</button>
        <button onClick={() => openDataPlace("skills", true, district.id)}>{district.label} · {cityText("本区技能学院", language)}</button>
      </nav></div>)}
      <p className="city-context-note">灰调背景楼为城市氛围 · 不计入会话</p>
      <p>会话楼高表示 token 规模；施工状态和生长进度是可视化估算，不代表任务完成度。</p>
      <p>{ui.projection?.source === "local" ? "本机只读投影 · 不上传数据" : "本地演示数据 · 尚未接入真实数据源"}</p>
    </section>}
    {catalog && !cinema && !gameActive && <aside className="city-catalog" aria-label="建筑说明">
      <button className="city-close" aria-label="关闭建筑说明" onClick={() => setCatalog(false)}>×</button>
      <h2>建筑说明</h2>
      <p>City 里每类建筑的样子与用途。「代表会话」的楼来自你的数据；其余是城市规模配套或装饰。点「查看实时模型」把镜头飞到岛上的实物。</p>
      {CATALOG_GROUPS.map((group) => <section key={group}><h3 className="city-catalog-group">{group}</h3><ul>{CITY_CATALOG.filter((entry) => entry.group === group).map((entry) => <li key={entry.id}>
        <img src={entry.image} alt="" loading="lazy" width="180" height="113" />
        <div><p className={`city-catalog-kind city-catalog-${entry.kind}`}>{CATALOG_KIND_LABEL[entry.kind]}</p>
          <h3>{entry.title}</h3><p>{entry.body}</p>
          <button disabled={locked} onClick={() => setMissing(ui.focusCatalog(entry.id) ? null : entry.id)}>查看实时模型</button>
          {missing === entry.id && <p role="status">当前岛上还没有这类建筑。</p>}
        </div>
      </li>)}</ul></section>)}
    </aside>}
    {!cinema && !gameActive && <section ref={timelineRef} className={`city-timeline${replayOpen ? " is-expanded" : ""}`} aria-label="时间回放">
      <button ref={replayButton} type="button" aria-expanded={replayOpen} aria-controls="city-replay-controls" onClick={() => setReplayOpen(!replayOpen)}>{replayOpen ? "收起回放" : "时间回放"}</button>
      <span className="city-replay-status">{ui.cursor === null ? "实时" : dateLabel(ui.cursor)}{ui.playing && <span aria-label="正在回放"> · ▶</span>}</span>
      {replayOpen && <div id="city-replay-controls" className="city-replay-controls">
      <button type="button" onClick={ui.replay} disabled={locked}>{ui.playing ? "暂停回放" : "播放回放"}</button>
      <input aria-label="时间游标" type="range" min="0" max="1000" value={slider} disabled={locked} onChange={(e) => ui.seek(Number(e.target.value))} />
      <select aria-label="回放速度" value={ui.speed} disabled={locked || ui.playing} onChange={(e) => ui.setSpeed(Number(e.target.value))}>
        <option value="600">每秒 10 分钟</option><option value="3600">每秒 1 小时</option><option value="14400">每秒 4 小时</option>
      </select>
      <button type="button" onClick={ui.live} disabled={locked || ui.cursor === null}>回到实时</button>
      </div>}
    </section>}
    {cinema && <div className="city-cinematic-overlay" aria-live="polite">
      <div className="city-cinema-top" /><div className="city-cinema-bottom"><span style={{ transform: `scaleX(${ui.progress})` }} /></div>
      {card && <div className="city-cinema-card"><p>{"eyebrow" in card ? card.eyebrow : ""}</p><h2>{card.title}</h2><p>{card.subtitle}</p></div>}
    </div>}
    {ui.selected === "decor:site:civic" && !dataOpen && !cinema && !gameActive && model && (() => {
      // 市政厅 = 全城的功能性标志：面板展示全城概况（用户：「市政广场的市政厅能提供哪些功能性信息」）。
      const total = model.stats.totalSessions || 1;
      const tier = scaleTierFor(Math.min(4000, Math.max(model.buildings.length, model.stats.totalSessions)));
      const stage = tier >= 8 ? "议会大厦" : tier >= 5 ? "市政中心" : tier >= 3 ? "市政厅" : "镇政厅";
      const ranked = [...model.districts].sort((a, b) => b.sessionCount - a.sessionCount);
      const alerts = ranked.filter((d) => d.anomaly);
      return <CityPanel eyebrow="市政厅 · 全城概况" title={stage} closeLabel="关闭建筑详情" onClose={ui.clearSelection} back={backToCatalog}>
        <button onClick={() => openDataPlace("overview")}>打开全窗口统计</button>
        <button onClick={() => openDataPlace("findings")}>打开诊断中心</button>
        <dl><dt>会话</dt><dd>{model.stats.totalSessions}</dd><dt>今日活跃</dt><dd>{model.stats.activeCount}</dd>
          <dt>全窗口 token</dt><dd>{tokens(ui.projection?.summary?.tokens.total ?? model.stats.tokensTotal)}</dd>
          <dt>已载入 token</dt><dd>{tokens(model.stats.tokensTotal)}</dd><dt>时间窗口</dt><dd>{model.windowLabel}</dd>
          <dt>岛屿档位</dt><dd>{tier} / 10（每档约 400 个会话）</dd></dl>
        <h3>城区份额</h3>
        {ranked.map((d) => <button key={d.id} className="city-civic-share" disabled={locked} onClick={() => ui.focusDistrict(d.id)}>
          <span style={{ background: paletteFor(d.id).accent, width: `${Math.max(4, (d.sessionCount / total) * 100)}%` }} />
          {d.label} · {d.sessionCount} · {Math.round((d.sessionCount / total) * 100)}%</button>)}
        {alerts.length ? <><h3>异常</h3>{alerts.map((d) => <p key={d.id}>{d.label} · {d.anomaly!.severity} · {d.anomaly!.count} 条（部分投影）</p>)}</> : <p>{ui.projection?.coverage.findings_state === "partial" ? "当前没有城区异常。" : "问题统计尚未载入，请打开诊断中心。"}</p>}
        <p>市政厅随岛屿档位升级；广场前的城区旗高度表示各城区会话占比，穹顶信标表示有城区异常。</p>
        {decorCamera}
      </CityPanel>;
    })()}
    {ui.selected && decorDistrictId(ui.selected) !== null && !dataOpen && !cinema && !gameActive && (() => {
      // 城区地标 = 城区的功能性标志：面板展示该执行环境城区的数据（用户：把城区信息放到「城区地标」说明上）。
      const districtId = decorDistrictId(ui.selected);
      const district = model?.districts.find((d) => d.id === districtId);
      if (!district) return null;
      return <CityPanel eyebrow="城区地标 · 执行环境城区" title={district.label} closeLabel="关闭建筑详情" onClose={ui.clearSelection} back={backToCatalog}>
        <dl><dt>会话</dt><dd>{district.sessionCount}</dd><dt>今日活跃</dt><dd>{district.activeCount}</dd>
          {district.anomaly && <><dt>异常</dt><dd>{district.anomaly.severity} · {district.anomaly.count} 条（部分投影）</dd></>}</dl>
        <p>{cityText("城区公共服务", language)} · {ui.districtServices(district.id).includes("hospital") ? cityText("医院已建成", language) : cityText("医院缺建：用地受限", language)} · {ui.districtServices(district.id).includes("school") ? cityText("学校已建成", language) : cityText("学校缺建：用地受限", language)}</p>
        <nav className="city-district-services" aria-label={cityText("城区公共服务", language)}>
          <button onClick={() => openDataPlace("findings", false, district.id)}>{cityText("本区诊断中心", language)}</button>
          <button onClick={() => openDataPlace("skills", false, district.id)}>{cityText("本区技能学院", language)}</button>
          <button onClick={() => openDataPlace("workflow", false, district.id)}>{cityText("本区工作流", language)}</button>
        </nav>
        <p>地标高度随本区会话数增长：会话越多，地标越高。</p>
        <button disabled={locked} onClick={() => ui.focusDistrict(district.id)}>聚焦城区</button>
        {decorCamera}
      </CityPanel>;
    })()}
    {ui.selected && isDecorId(ui.selected) && decorDistrictId(ui.selected) === null && ui.selected !== "decor:site:civic" && !dataOpen && !cinema && !gameActive && (() => {
      const info = describeDecor(ui.selected);
      if (!info) return null;
      return <CityPanel eyebrow={info.category} title={info.title} closeLabel="关闭建筑详情" onClose={ui.clearSelection} back={backToCatalog}>
        <p>{info.body}</p>
        {cityDataPlaceForDecor(ui.selected) && <button onClick={() => openDataPlace(cityDataPlaceForDecor(ui.selected), false, ui.serviceDistrict(ui.selected))}>打开设施数据</button>}
        <p>这不是会话楼：没有 token、时间或会话详情可钻取。</p>
        {decorCamera}
      </CityPanel>;
    })()}
    {/* 楼名（V32）：会话标题优先；无标题证据时回退城区名（聚合楼没有标题，恒走回退）。 */}
    {selected && !dataOpen && !cinema && !gameActive && <CityPanel eyebrow={<>建筑 · {selected.aggregated ? "聚合会话" : "会话"}</>} closeLabel="关闭建筑详情" onClose={ui.clearSelection} back={backToCatalog}
      title={session?.title ?? model?.districts.find((d) => d.id === selected.districtId)?.label ?? selected.districtId}>
      {model && selected.tokensTotal >= Math.max(...model.buildings.map((b) => b.tokensTotal)) && <p className="city-hero-note">全城之最：本窗口 token 最多的会话。它戴尖顶冠，夜里顶上亮一道探照光柱，方便在全城找到它。</p>}
      {session?.title && <p className="city-session-title-source">标题来自{titleSourceLabel(session.title_source) ?? "未知来源"}</p>}
      <dl><dt>Token</dt><dd>{tokens(selected.tokensTotal)}</dd><dt>状态</dt><dd>{selected.active ? "活跃 · 施工中" : "非活跃 · 已封顶"}</dd>
        <dt>进度估算</dt><dd>{Math.round(selected.builtFraction * 100)}%</dd><dt>起始时间</dt><dd>{dateLabel(selected.startedAt)}</dd>
        <dt>事件数</dt><dd>{session?.event_count ?? "未投影"}</dd>
        <dt>模型</dt><dd>{session?.model_ids?.length ? session.model_ids.join("、") : "无模型标识"}</dd>
        <dt>费用</dt><dd>{costLabel(session)}</dd></dl>
      {ui.orbitLocked !== selected.id && <button disabled={locked} onClick={() => ui.lockSelection(selected.id)}>锁定视角</button>}
      {ui.orbitLocked === selected.id && <button onClick={ui.releaseOrbitLock}>解除视角锁定</button>}
      <p className="city-camera-help">{ui.orbitLocked === selected.id ? "已锁定建筑中心：左键拖动环绕，滚轮缩放。" : "自由视角：左键环绕，右键平移，滚轮朝指针缩放。"}</p>
      <p className="city-camera-help">画布内按 F 锁定目标；Esc 退出选择。</p>
      <p className="city-camera-help">点击空白处取消锁定；镜头远近由滚轮控制。</p>
      {session && <button onClick={() => ui.setDetails(true)}>查看会话详情</button>}
      {selected.aggregated && <p>此建筑代表 {selected.extraCount} 个会话，不支持单独钻取。</p>}
      <p>建筑和施工仅为数据隐喻。</p>
    </CityPanel>}
    <dialog className="city-dialog" ref={detailsRef} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); ui.setDetails(false); }} onClose={() => ui.setDetails(false)} aria-label="会话详情">
      <header className="city-dialog-header"><h2>会话详情</h2><button className="city-close" aria-label="关闭会话详情" onClick={() => ui.setDetails(false)}>×</button></header>
      <div className="city-dialog-body">
      {session && <><p>{session.harness} · {session.first_event_at}</p>
        {session.title && <p className="city-session-title" title={session.title}>{session.title}<span className="city-session-title-source"> · {titleSourceLabel(session.title_source) ?? "未知来源"}</span></p>}
        <dl><dt>输入 token（含缓存）</dt><dd>{tokens(session.tokens.input)}</dd>
          <dt>未缓存输入</dt><dd>{tokens(session.tokens.uncached_input ?? session.tokens.input)}</dd>
          <dt>缓存读取</dt><dd>{tokens(session.tokens.cache_read ?? 0)}</dd>
          <dt>缓存写入</dt><dd>{tokens(session.tokens.cache_write ?? 0)}</dd>
          <dt>输出 token</dt><dd>{tokens(session.tokens.output)}</dd>
          <dt>窗口内首事件</dt><dd>{session.window_first_event_at ?? session.first_event_at}</dd>
          <dt>窗口内末事件</dt><dd>{session.window_last_event_at ?? session.last_event_at}</dd>
          <dt>会话生命周期起点</dt><dd>{session.lifetime_first_event_at ?? "未投影"}</dd>
          <dt>会话生命周期终点</dt><dd>{session.lifetime_last_event_at ?? "未投影"}</dd>
          <dt>模型</dt><dd>{session.model_ids?.length ? session.model_ids.join("、") : "无模型标识"}</dd>
          <dt>费用</dt><dd>{costLabel(session)}</dd><dt>统计截止</dt><dd>{session.last_event_at}</dd></dl>
        {detailState === "loading" && <p role="status">正在读取会话详情…</p>}
        {detailState === "unavailable" && <p role="status">详情暂不可用；已尝试重新读取快照。若城市仍在更新，请稍候后重开详情。</p>}
        {session.excerpt_scope === "session_lifetime_not_window" && <p>摘录来自整个会话，可能早于当前统计窗口。</p>}
        <p>会话定位号（可能变化）：{session.id}</p>
        {session.asset_ref && <BuildingBookmark key={session.asset_ref} assetRef={session.asset_ref} language={language} windowDays={ui.projection!.window.days} />}
        {session.asset_ref && <><p>楼号：{session.asset_ref}</p><button onClick={() => { void navigator.clipboard?.writeText(session.asset_ref!).catch(() => setDetailState("unavailable")); }}>复制楼号</button></>}
        {session.cost_breakdown && session.cost_breakdown.length > 0 && <><h3>分项估价（按币种和依据）</h3>
          {session.cost_breakdown.map((part) => <p key={`${part.currency}:${part.basis}`}>{costLabel({ ...session, cost_minor: part,
            cost_status: { state: "estimated", reason: "breakdown", has_unresolved: session.cost_status?.has_unresolved ?? true } })}</p>)}
          {session.cost_complete === false && <p>部分用量无法估价；分项仅包含可计价部分。</p>}</>}
        {detailState === "ready" && <><h3>用户输入摘录</h3>{session.task_excerpts?.length ? session.task_excerpts.map((excerpt, i) => <section key={i} className="city-excerpt"><p>{excerpt.role === "user_first" ? "首次输入" : "后续输入"} · {excerpt.provenance === "truncated" ? "已截断" : excerpt.provenance === "scrubbed" ? "已清理" : "有限摘录"}</p><blockquote>{excerpt.text}</blockquote></section>) : <p>当前数据没有可用摘录。</p>}</>}
        <p>摘录并非完整提示词。费用是本地价格卡估算，不代表实际账单；无法确认的路由或价格会明确标记。原始日志、调用参数、provider 详情及原始异常不会投影到此插件。</p></>}
      </div>
      <div className="city-dialog-actions"><button disabled={ui.projection?.source !== "local"} onClick={() => void ui.openHostSession()}>在宿主打开完整会话详情</button></div>
    </dialog>
    {dataPlace && ui.projection && !cinema && !gameActive && <CityDataFacility id={dataPlace} harness={dataDistrict} projection={ui.projection} language={language}
      back={dataBack} onClose={() => { setDataPlace(null); ui.clearSelection(); }} onLocate={ui.focusCatalog} />}
    <dialog className="city-dialog" ref={settingsRef} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); ui.setOptions(false); }} onClose={() => ui.setOptions(false)} aria-label="城市设置">
      <header className="city-dialog-header"><h2>城市设置</h2><button className="city-close" aria-label="关闭城市设置" onClick={() => ui.setOptions(false)}>×</button></header>
      <div className="city-dialog-body">
      {!landingPreview && <><form onSubmit={(e) => { e.preventDefault(); void ui.applySeed(Number(ui.seedDraft.trim())); }}>
        <label htmlFor="city-seed">岛屿种子</label><div className="city-seed-controls"><input id="city-seed" inputMode="numeric" value={ui.seedDraft} disabled={locked} onChange={(e) => ui.setSeedDraft(e.target.value)} />
        <button disabled={locked}>应用种子</button></div>
      </form>
      <button onClick={ui.reseed} disabled={locked}>{ui.confirmSeed ? "确认重新生成（4 秒内）" : "重新生成岛屿"}</button>
      <p>只改变地形与布局，不删除会话数据。种子保存于插件私有本地状态。</p></>}
      <label htmlFor="city-backdrop">城市背景楼</label><select id="city-backdrop" value={ui.backdrop} disabled={locked} onChange={(e) => ui.setBackdrop(e.target.value as BackdropMode)}><option value="auto">自动（随会话数，不挤占城区）</option><option value="off">关闭（纯数据城市）</option><option value="full">繁华（铺满城区周边）</option></select>
      <p>背景楼只是城市氛围，不是会话，不可点击，不计入统计。</p>
      <label htmlFor="city-window">时间范围</label><select id="city-window" value={String(windowDays)} disabled={locked || gameActive} onChange={(e) => onWindowDays(Number(e.target.value))}>{windowOptions.map((days) => <option key={days} value={String(days)}>{`${days} 天`}</option>)}</select>
      <label className="city-check" htmlFor="city-labels"><input id="city-labels" type="checkbox" checked={labels} disabled={locked || gameActive} onChange={(e) => onLabels(e.target.checked)} />显示建筑标签</label>
      <label htmlFor="city-quality">画质</label><select id="city-quality" value={quality} onChange={(e) => onQuality(e.target.value)}><option value="auto">自动</option><option value="high">高画质</option><option value="eco">节能</option></select>
      {!landingPreview && <><label htmlFor="city-cut">航拍与视频长度</label><select id="city-cut" value={ui.cut} disabled={locked} onChange={(e) => ui.setCut(e.target.value as CinematicCut)}><option value="short">短片</option><option value="full">完整航线</option></select>
      <details className="city-settings-help"><summary>导出说明</summary><p>拍照保存 PNG；视频后台逐帧生成 30 FPS MP4（H.264；环境不支持时改为 WebM），并显示实际生成画面的低帧率预览。硬件渲染为 1080p，软件渲染降至 360p。导出中暂停拍照，避免并发导出和保存；离开 City 会取消任务。不上传数据。</p></details>
      <div className="city-game-entry">
        <label style={{ fontSize: 12, color: "var(--city-muted)" }}>{gameText("游戏模式", language === "en" ? "en" : "zh-Hans")}</label>
        {/* 空投影也允许在生成的空岛练习（§1.1）：门槛是「城市已建模」而非 sceneReady。 */}
        <div style={{ display: "flex", gap: 8 }}>
          <button disabled={cinema || ui.busy || gameActive || !ui.model} onClick={() => { ui.setOptions(false); game.enterPractice(); }}>{gameText("自由练习", language === "en" ? "en" : "zh-Hans")}</button>
          <button disabled={cinema || ui.busy || gameActive || !ui.model} onClick={() => { ui.setOptions(false); game.enterRace(); }}>{gameText("穿环挑战", language === "en" ? "en" : "zh-Hans")}</button>
          <button disabled={cinema || ui.busy || gameActive || disabled || !ui.model || !onMecha || mechaAvailability === "empty"} onClick={() => { ui.setOptions(false); onMecha?.(); }}>{gameText("机甲战棋", language === "en" ? "en" : "zh-Hans")}</button>
          {typeof __CITY_GAME_UAT__ !== "undefined" && __CITY_GAME_UAT__ && <button disabled={cinema || ui.busy || gameActive || !ui.model} onClick={() => { ui.setOptions(false); void game.enterUatRace(); }}>UAT keyboard pilot</button>}
        </div>
        {game.entryError && <p role="alert">{game.entryError}</p>}
        <p>{gameText("进入后用 W/S/A/D 与方向键飞行，Esc 暂停。", language === "en" ? "en" : "zh-Hans")}</p>
        <p>{gameText(mechaAvailability === "empty" ? "这座城暂时没有可用机坪，不能开战。" : "在这座城市的机坪上开战。整包提交，非法则整包退回。没有机坪时不会进入对局。", language === "en" ? "en" : "zh-Hans")}</p>
      </div>
      {ui.film && <p role="status" aria-atomic="true">航拍导出 {Math.round(ui.film.frame / ui.film.total * 100)}% · 关闭设置不取消导出</p>}
      {!supportsBackgroundFilm() && <p>当前环境不支持后台视频导出；可使用拍照。</p>}</>}
      <label htmlFor="city-session">选择会话（键盘入口）</label><select id="city-session" value={ui.selected ?? ""} disabled={disabled || ui.busy} onChange={(e) => { ui.setSelected(e.target.value || null); if (e.target.value) ui.lockSelection(e.target.value); else ui.clearSelection(); ui.setOptions(false); }}>
        <option value="">请选择</option>{(ui.projection?.sessions ?? []).map((session) => <option key={session.id} value={session.id}>{session.title ? `${session.title} · ` : ""}{session.harness} · {session.first_event_at} · {tokens(session.tokens.total)} tokens</option>)}
      </select>
      {ui.error && <p role="alert">{ui.error}</p>}
      </div>
    </dialog>
    {ui.film && <section className="city-export-preview" aria-label="航拍导出预览">
      <canvas ref={ui.previewRef} width="640" height="360" aria-label="后台实际生成的航拍画面" />
      <div><p role="status" aria-atomic="true">航拍导出 {Math.round(ui.film.frame / ui.film.total * 100)}% {ui.film.width && `${ui.film.width}×${ui.film.height}${ui.film.software ? " · 软件渲染" : ""}`}</p>
      <button onClick={() => void ui.exportFilm()}>取消导出</button></div>
      <small>实际生成帧 · 预览最多 2 FPS，成片 30 FPS</small>
    </section>}
    {ui.error && !ui.options && <div className="city-feature-error" role="alert">{ui.error}<button aria-label="关闭提示" onClick={() => ui.setError(null)}>×</button></div>}
    {!cinema && !gameActive && <PlanRepairPanel repair={planRepair} />}
    {game.active && game.snapshot && <GameHud snapshot={game.snapshot} locale={language === "en" ? "en" : "zh-Hans"} persist={{ tier: game.persistTier, saveFailed: game.saveFailed }} actions={{
      onResume: game.resume, onRestart: game.restart, onExit: game.exit, onRetryPrepare: game.retryPrepare, onNewCourse: game.newCourse, onSoundVolume: game.setSoundVolume, onToggleSfx: game.toggleSfx, onToggleMusic: game.toggleMusic,
      onPause: () => game.pause("user"),
    }} />}
    {debug && ui.stats && <p className="city-perf">{ui.stats.fps} FPS · {ui.stats.drawCalls} draw calls · {ui.stats.buildings} buildings · geo {ui.stats.geometries} · tex {ui.stats.textures} · quality {ui.stats.quality}</p>}
  </>, language);
}
