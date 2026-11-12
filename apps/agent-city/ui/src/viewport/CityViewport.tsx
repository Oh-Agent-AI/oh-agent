import { useEffect, useMemo, useRef, useState } from "react";
import { buildCityModel } from "../cityModel";
import { prepareCityWorldLayout } from "../engine/cityLayout";
import { readCityAppearancePreference, type CityWorldProfileV1 } from "../engine/cityWorldProfile";
import { CityEngine } from "../engine/CityEngine";
import { tauriCityDataProvider, type CityProjectionV1 } from "../data/provider";
import { cityPlanPatchStore } from "../data/planPatch";
import type { PlanPatchV1 } from "../engine/planPatch";
import { PlanRepairSession, type RepairCandidate } from "../planRepair/session";
import { noteBusy } from "../host";
import { cityText, useCityLanguage } from "../i18n";
import { replayStartMs } from "../replayRange";
import type { PlanningWorkSnapshot } from "../engine/planner/operationBudget";
import { projectionSessionRows, type CityViewportWindowDays } from "./projectionRows";
import { readCityWindowDays } from "./windowPreference";
import { createMoveGhost, type MoveGhost } from "./moveGhost";
import "../city.css";

export type CityViewportProps = {
  /** 城市种子。Studio 传当前项目绑定的布局快照 seed，保证和 City 是同一座城。 */
  seed: number;
  /** 缺省读与 City 共享的窗口偏好；City 改窗口后 Studio 跟随，避免装出不同布局。 */
  windowDays?: CityViewportWindowDays;
  worldProfile?: CityWorldProfileV1;
  /** 引擎创建/销毁回调；父页面需要引擎实例（如后续编辑操作）时使用。 */
  onEngineChange?: (engine: CityEngine | null) => void;
  /** 允许在视口里选取会话楼并移动到就近地块：复用现有修复会话的校验/存档机器。
   *  目标候选先由用户手选；Agent 提案经 MCP 接入后走同一 moveBuilding 入口。 */
  editable?: boolean;
  /** 递增信号：父页面（打开/切回项目、试玩返回）触发视口回到全局视角。 */
  focusSignal?: number;
};

type BuildingSelection = { id: string; candidates: RepairCandidate[] };

type ViewportLoadState = Readonly<{ stage: "data" | "model" | "planning" | "mounting" | "rendering"; work: number | null }>;

/**
 * Studio 复用的最小实时城市视口：只负责「引擎生命周期 + 投影数据 + 修复补丁 → 场景装配」。
 * 选取、修复、游戏、机甲等交互留在 CityApp；两边共享同一个 CityEngine、
 * 同一份投影提供方、同一个布局规划器和同一份补丁存档（同源 localStorage），所以看到的是同一座城市。
 * 暂停/恢复沿用引擎已注册的宿主 __AV_PLUGIN_SUSPENDED__/RESUMED__ 事件与
 * visibilitychange，销毁入口就是组件卸载时的 engine.dispose()。
 */
export function CityViewport({ seed, windowDays, worldProfile, onEngineChange, editable = false, focusSignal = 0 }: CityViewportProps) {
  const days = windowDays ?? readCityWindowDays();
  const language = useCityLanguage();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CityEngine | null>(null);
  const onEngineChangeRef = useRef(onEngineChange);
  onEngineChangeRef.current = onEngineChange;
  const [projection, setProjection] = useState<CityProjectionV1 | null>(null);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [sceneUnavailable, setSceneUnavailable] = useState(false);
  const [firstModelFrame, setFirstModelFrame] = useState(false);
  const [cityLoad, setCityLoad] = useState<ViewportLoadState>({ stage: "data", work: null });
  const [patch, setPatch] = useState<PlanPatchV1 | null>(null);
  // 选取与移动状态：editable 下点会话楼 → 聚焦 + 就近候选；移动经修复会话提交。
  const [engineState, setEngineState] = useState<CityEngine | null>(null);
  const [selection, setSelection] = useState<BuildingSelection | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const sessionRef = useRef<PlanRepairSession | null>(null);
  // 候选 ghost 的当前实例：卡片按钮 hover 时经它高亮场景里的对应盒体（见 moveGhost.ts）。
  const ghostRef = useRef<MoveGhost | null>(null);
  const editableRef = useRef(editable);
  editableRef.current = editable;
  // 未显式传外观时与 City 同源读取偏好；useMemo 保持引用稳定，引擎不会因渲染重建。
  const profile = useMemo(() => worldProfile ?? readCityAppearancePreference(), [worldProfile]);
  // 选取入口：点击回调用它，window 调试/自动化钩子（同 CityApp __AV_CITY_SELECT__ 先例）也用它。
  const selectBuilding = (id: string | null) => {
    if (!id) { setSelection(null); return; }
    const session = sessionRef.current;
    const engine = engineRef.current;
    if (!session || !engine) return;
    // 只有能移动的会话楼进入选中态；背景楼/地块装饰点了不算。
    const candidates = session.candidates(id, 5);
    if (!candidates.length) { setSelection(null); return; }
    engine.focusBuilding(id);
    setMoveError(null);
    setSelection({ id, candidates });
  };
  const selectRef = useRef(selectBuilding);
  selectRef.current = selectBuilding;

  // 引擎创建/销毁必须先于装配 effect 声明：同一次提交里先建引擎，装配才能拿到实例。
  // setSeed 必须在装配前完成——engine.seed 为 null 时 applyModel 会静默早退，
  // 场景只剩天空（曾让 Studio 视口一片素色）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: CityEngine;
    try {
      engine = new CityEngine({ canvas, worldProfile: profile, onFirstFrame: () => setFirstModelFrame(true), onSelect: (id) => {
        if (!editableRef.current || !id) { setSelection(null); return; }
        selectRef.current(id);
      } });
      engine.setSeed(seed);
    } catch {
      setSceneUnavailable(true);
      return;
    }
    engineRef.current = engine;
    setEngineState(engine);
    onEngineChangeRef.current?.(engine);
    return () => {
      engine.dispose();
      engineRef.current = null;
      setEngineState(null);
      onEngineChangeRef.current?.(null);
    };
  }, [profile, seed]);

  // 修复会话跟随当前引擎（引擎重建时旧会话必须作废）：存档读写与移动校验都在
  // PlanRepairSession 内，视口只发起操作、展示候选与结果；存档状态经底部状态条持续可见。
  const [saveState, setSaveState] = useState<"saved" | "pending" | "failed" | null>(null);
  useEffect(() => {
    if (!editable || !engineState) return;
    const session = new PlanRepairSession(engineState);
    sessionRef.current = session;
    session.onSaveSettled = () => {
      const status = session.status();
      setSaveState(status.saveFailed ? "failed" : status.savePending ? "pending" : "saved");
    };
    void session.load(seed).then(() => setSaveState("saved"));
    return () => { session.dispose(); sessionRef.current = null; };
  }, [editable, engineState, seed]);

  // 移动候选 ghost：选中时把每个候选地块画成半透明盒体挂到场景根（CityEngine.addOverlay），
  // 让用户在地图上直接比较候选位置，而不仅靠卡片文字。依赖 engineState（引擎实例）而非
  // engineRef：引擎因 worldProfile/seed 重建时依赖变化会先走清理——从旧引擎摘下并 dispose
  // 旧 group，再在新引擎上重挂，与上面会话跟随引擎的守卫思路一致。applyModel 重建 CityParts
  // 不影响它（叠加层本来就挂在 parts 之外的场景根上）。
  useEffect(() => {
    if (!engineState) return;
    const engine = engineState;
    const ghost = selection && selection.candidates.length ? createMoveGhost(selection.candidates) : null;
    if (!ghost) return;
    ghostRef.current = ghost;
    engine.addOverlay(ghost.group);
    return () => {
      // 卸载顺序先摘后释放：引擎 dispose 先于本清理执行时，removeOverlay 在已停渲染的场景根上
      // 只是把对象摘出场景，仍然安全（与 CityApp 卸载 creator 模型叠加层同款顺序）。
      engine.removeOverlay(ghost.group);
      ghost.dispose();
      if (ghostRef.current === ghost) ghostRef.current = null;
    };
  }, [engineState, selection]);

  // 父页面信号：打开/切回项目、试玩返回后回到全局视角。
  useEffect(() => { if (focusSignal > 0) engineRef.current?.resetView(); }, [focusSignal]);

  const applyMove = (parcelId: string) => {
    const session = sessionRef.current;
    if (!session || !selection) return;
    const result = session.moveBuilding(selection.id, parcelId);
    if (result.ok) { setSelection(null); setMoveError(null); }
    else setMoveError(result.reason === "blocked" ? `无法移动：${(result.blockers ?? []).join("、")}` : result.reason);
  };
  const [editTick, setEditTick] = useState(0);
  const bumpEdit = () => setEditTick((value) => value + 1);
  const sessionStatus = editable && sessionRef.current ? sessionRef.current.status() : null;
  void editTick;

  useEffect(() => {
    let active = true;
    const loading = new AbortController();
    setCityLoad({ stage: "data", work: null });
    // 与 CityApp 同一份投影提供方；数据授权按活动插件描述符在宿主侧逐请求校验。
    tauriCityDataProvider.getProjection({ windowDays: days, signal: loading.signal }).then((data) => {
      if (!active) return;
      setProjection(data);
      setDataLoaded(true);
      setCityLoad({ stage: "model", work: null });
    }).catch(() => {
      if (!active) return;
      setDataLoaded(true);
      setCityLoad({ stage: "data", work: null });
    });
    return () => { active = false; loading.abort(); };
  }, [days]);

  // 修复补丁与 City 同源读取（宿主投影未注册时回落同源 localStorage，见 data/planPatch.ts）。
  // 不套补丁的话，用户搬过的楼、修过的路在 Studio 里会恢复成生成时的样子。
  useEffect(() => {
    let active = true;
    void cityPlanPatchStore("read").then((store) => {
      if (!active) return;
      setPatch(store?.patches[String(seed)] ?? null);
    }).catch(() => { if (active) setPatch(null); });
    return () => { active = false; };
  }, [seed]);

  useEffect(() => {
    if (!firstModelFrame) return;
    void noteBusy(8_000).catch(() => {});
  }, [firstModelFrame]);

  const fingerprint = useRef("");
  const patchFingerprint = useRef("");
  const geographyKey = useRef("");
  const geographyAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { geographyAbort.current?.abort(); }, []);
  useEffect(() => {
    const engine = engineRef.current;
    if (!projection || !engine) return;
    const patchForSeed = patch?.seed === seed ? patch : null;
    const patchKey = patchForSeed
      ? `${patchForSeed.updatedAt}:${Object.keys(patchForSeed.buildingMoves).length}:${patchForSeed.roadOps.length}:${patchForSeed.highwayOps?.length ?? 0}:${patchForSeed.siteOps.length}`
      : "";
    const model = buildCityModel({
      harnessNames: Object.fromEntries(projection.harnesses.map((h) => [h.id, h.display_name])),
      rows: projectionSessionRows(projection),
      findings: projection.findings.map((finding) => ({
        harness: finding.harness,
        rule: "harness_summary",
        severity: finding.severity,
        status_rollup: { open: finding.count, later: 0 },
      })),
      windowStartMs: replayStartMs(projection.sessions, Date.parse(projection.window.from), Date.parse(projection.window.to)),
      windowEndMs: Date.parse(projection.window.to),
      windowLabel: projection.window.label,
      totalSessions: projection.coverage.total,
      truncated: projection.coverage.truncated,
      generatedAt: Date.parse(projection.generated_at ?? new Date().toISOString()),
    });
    // 地理键由窗口 + 种子 + 规模决定；键不变时不重排全城，只走增量挂载——
    // 与 CityApp 的装配管线一致，避免两边对同一投影做出不同重建。
    const planned = Math.min(4000, Math.max(projection.sessions.length, projection.coverage.total));
    const geography = JSON.stringify([projection.window, seed, planned]);
    const occupants = projection.sessions.map((session) => session.id).join("\0");
    const signature = `${geography}|${occupants}|${JSON.stringify(projection.findings)}`;
    if (signature === fingerprint.current) {
      if (patchKey === patchFingerprint.current) return;
      // 只有补丁变了：引擎按移楼钉子对比走快路径（缓存的底层布局上重套补丁），与 City 的 setPlanPatch 一致。
      engine.setPlanPatch(patchForSeed);
      patchFingerprint.current = patchKey;
      return;
    }
    geographyAbort.current?.abort();
    const preparation = new AbortController();
    geographyAbort.current = preparation;
    geographyKey.current = geography;
    fingerprint.current = "";
    setFirstModelFrame(false);
    setCityLoad({ stage: "planning", work: null });
    void prepareCityWorldLayout(model, seed, profile, { signal: preparation.signal,
      onPlanningProgress: (snapshot: PlanningWorkSnapshot) => {
        const work = Object.values(snapshot.consumed).reduce((sum, value) => sum + value, 0);
        setCityLoad({ stage: "planning", work });
      } }).then(async () => {
      if (preparation.signal.aborted || engineRef.current !== engine) return;
      setCityLoad({ stage: "mounting", work: null });
      await noteBusy(15_000).catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (preparation.signal.aborted || engineRef.current !== engine) return;
      // 布局装配前先交补丁：移楼钉子参与底层布局，装配顺序与 City（session.load → applyModel）一致。
      engine.setPlanPatch(patchForSeed);
      patchFingerprint.current = patchKey;
      engine.applyModel(model, false);
      setCityLoad({ stage: "rendering", work: null });
      // applyModel 在返回前同步渲染该模型的首帧。
      setFirstModelFrame(true);
      fingerprint.current = signature;
    }).catch(() => {
      if (!preparation.signal.aborted) { setSceneUnavailable(true); setCityLoad({ stage: "data", work: null }); }
    });
    return () => preparation.abort();
  }, [projection, seed, profile, patch]);

  const dataAvailable = projection !== null && projection.status !== "unavailable";
  const cityLoading = !sceneUnavailable && (!dataLoaded || (dataAvailable && projection.status !== "empty" && !firstModelFrame));
  // 与 CityApp 的 __AV_CITY_PROBE__ 同款轻量调试口：工作台/自动化用它读视口装配状态。
  useEffect(() => {
    (window as Window & { __CITY_VIEWPORT_PROBE__?: () => Record<string, unknown> }).__CITY_VIEWPORT_PROBE__ = () => ({
      seed, engine: engineRef.current?.diagnosticState() ?? null, projection: projection?.status ?? null,
      cityLoad, firstModelFrame, sceneUnavailable, editable,
      selection: selection ? { id: selection.id, candidates: selection.candidates.length } : null,
      moveError,
      sessionReady: !!sessionRef.current,
      districtSlots: engineRef.current?.currentLayout?.districts.flatMap((district) => [...district.slots.keys()]).slice(0, 8) ?? null,
      probeCandidates: (id: string) => sessionRef.current?.candidates(id, 5) ?? null,
      select: (id: string | null) => selectRef.current(id),
      scene: (() => {
        const inspected = engineRef.current?.inspectScene();
        return inspected ? { occupantCount: inspected.occupantCount, camera: inspected.camera, lastApplyMode: inspected.lastApplyMode, scaleTier: inspected.scaleTier,
          kits: (inspected.kits ?? []).map((kit) => kit.sessionId) } : null;
      })(),
    });
    return () => { delete (window as Window & { __CITY_VIEWPORT_PROBE__?: () => Record<string, unknown> }).__CITY_VIEWPORT_PROBE__; };
  });
  const sceneMessage = sceneUnavailable ? cityText("当前环境无法显示三维城市，仍可查看会话摘要。", language)
    : dataLoaded && !dataAvailable ? cityText("City 数据暂不可用", language)
    : projection?.status === "empty" ? cityText("当前时间范围没有会话", language)
    : null;
  return (
    <section className="city-app city-viewport" aria-label="Creator Studio City 视口">
      <canvas className="city-canvas" ref={canvasRef} aria-label="Agent City 三维城市" />
      {cityLoading && <div className="city-loading" role="status" aria-live="polite">
        <div className="city-loading-card"><div className="city-loading-mark" aria-hidden="true"><span /><span /><span /><i /></div>
          <p className="city-loading-kicker">AGENT CITY</p>
          <h2>{cityLoad.stage === "data" ? "读取城市数据" : cityLoad.stage === "model" ? "整理城市数据" : cityLoad.stage === "planning" ? "规划道路与街区" : cityLoad.stage === "mounting" ? "装配城市" : "等待城市首帧"}</h2>
          <p>{cityLoad.stage === "data" ? "正在读取会话建筑…" : cityLoad.stage === "model" ? "正在组织会话与建筑数据" : cityLoad.stage === "planning" ? cityLoad.work === null ? "正在计算道路、地形与街区" : `规划器已完成 ${cityLoad.work.toLocaleString()} 项工作单元` : cityLoad.stage === "mounting" ? "正在创建三维场景对象" : "城市即将就绪"}</p>
          <div className="city-loading-track" aria-hidden="true"><span /></div>
          <small>{cityLoad.stage === "planning" && cityLoad.work !== null ? "显示规划器实际完成的工作量，不代表百分比" : "复杂城市需要一些时间，请稍候"}</small>
        </div>
      </div>}
      {sceneMessage && !cityLoading && <p className="city-scene-message" role="status">{sceneMessage}</p>}
      {editable && saveState && <div className="viewport-savebar" role="status">{saveState === "pending" ? "草稿保存中…"
        : saveState === "failed" ? "保存失败：本次修改仅临时生效，可重试" : "草稿已保存"}</div>}
      {editable && selection && <div className="selection-card" role="dialog" aria-label="选中建筑">
        <div className="selection-head"><strong>选中建筑</strong><code>{selection.id}</code><button className="secondary" onClick={() => setSelection(null)}>关闭</button></div>
        <p className="selection-hint">就近可移动地块（按距离，移动即保存到草稿）：</p>
        {selection.candidates.map((candidate, index) => <button key={candidate.parcelId} className="candidate" onClick={() => applyMove(candidate.parcelId)}
          onMouseEnter={() => ghostRef.current?.setHighlighted(index)}
          onMouseLeave={() => ghostRef.current?.setHighlighted(null)}>
          移到 {candidate.parcelId.length > 20 ? `${candidate.parcelId.slice(0, 20)}…` : candidate.parcelId} · {candidate.distance}m{candidate.warnings.length ? ` · ${candidate.warnings.join("、")}` : ""}
        </button>)}
        <div className="selection-foot">
          <button className="secondary" disabled={!(sessionStatus?.canUndo)} onClick={() => { sessionRef.current?.undo(); bumpEdit(); }}>撤销</button>
          <button className="secondary" disabled={!(sessionStatus?.canRedo)} onClick={() => { sessionRef.current?.redo(); bumpEdit(); }}>重做</button>
        </div>
        {moveError && <p className="status" role="status">{moveError}</p>}
      </div>}
    </section>
  );
}
