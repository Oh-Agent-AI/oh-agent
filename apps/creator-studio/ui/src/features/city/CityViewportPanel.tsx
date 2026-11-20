import type { RefObject } from "react";
import { validateWorldPlanPatch, type CityInstanceV1, type CityWorldProfileV1 } from "@oh-agent/city-sdk";
import type { CityViewStatus, CityWorldSnapshot, Project, ProjectCityState } from "../../contracts/creatorStudio";
// 视口与 City 插件共享同一份引擎与装配管线，保证 Studio 看到的是同一座城市。
import { CityViewport } from "../../../../../agent-city/ui/src/viewport/CityViewport";
import type { CityEngine } from "../../../../../agent-city/ui/src/engine/CityEngine";
import { CITY_GENERATOR_VERSION, type PlanPatchV1 } from "../../../../../agent-city/ui/src/engine/planPatch";

export type AgentCityPreview = {
  patch: PlanPatchV1;
  seed: number;
  worldRevision: string;
  baseEngine: CityEngine | null;
  isolated: boolean;
  profile: CityWorldProfileV1;
};

export function CityViewportPanel(props: Readonly<{
  installedWorldView: CityWorldSnapshot | null;
  draftCityView: CityInstanceV1 | null;
  draftCityViewRef: RefObject<CityInstanceV1 | null>;
  draftEngineRef: RefObject<CityEngine | null>;
  draftViewStatusRef: RefObject<CityViewStatus>;
  draftViewFailureRef: RefObject<string | undefined>;
  recordCityDiagnostic: (city: CityInstanceV1, event: string, code?: string) => Promise<void>;
  projectCityKey: string | null;
  projectCity: ProjectCityState | null;
  project: Project | null;
  viewportSeed: number | null;
  viewportUnavailable: boolean;
  worldProfile: CityWorldProfileV1;
  focusSignal: number;
  busy: boolean;
  browserPreview: boolean;
  agentCityPreview: AgentCityPreview | null;
  agentPreviewId: string | undefined;
  onResetView: () => void;
  onCloseInstalledWorld: () => void;
  onCloseDraftCity: () => void;
  onOpenProject: () => void;
  onExportCitySource: () => void;
  onMessage: (message: string) => void;
  setBaseEngine: (engine: CityEngine | null) => void;
  setBaseStatus: (status: CityViewStatus) => void;
  commitPatchRef: RefObject<(patch: PlanPatchV1) => void>;
  onAgentViewportStatus: (status: CityViewStatus, code?: string) => void;
}>) {
  const {
    installedWorldView, draftCityView, draftCityViewRef, draftEngineRef, draftViewStatusRef, draftViewFailureRef,
    recordCityDiagnostic, projectCityKey, projectCity, project, viewportSeed, viewportUnavailable, worldProfile, focusSignal, busy, browserPreview,
    agentCityPreview, agentPreviewId, onResetView, onCloseInstalledWorld, onCloseDraftCity, onOpenProject, onExportCitySource, onMessage,
    setBaseEngine, setBaseStatus, commitPatchRef, onAgentViewportStatus,
  } = props;
  const scopedProjectPatch = projectCity?.city ? project?.cityPatch ?? projectCity.city.planPatch : null;
  const isolatedPatchResult = projectCityKey && projectCity?.key === projectCityKey && projectCity.city && scopedProjectPatch
    ? validateWorldPlanPatch(scopedProjectPatch, projectCity.city.seed, CITY_GENERATOR_VERSION) : null;
  return <section className="viewport" aria-label="City 实时视口">
    <div className="viewport-head"><div className="section-title">城市视图</div><span className="viewport-hint">点选建筑移动 · 拖动旋转 · 滚轮缩放</span><button className="secondary reset-view" onClick={onResetView}>重置视角</button></div>
    <div className="viewport-base">{installedWorldView && "defaultSeed" in installedWorldView.manifest.entry ? <div className="viewport-frame"><CityViewport key={draftCityView ? `${draftCityView.cityId}:${draftCityView.revision}:${installedWorldView.manifest.contentDigest}` : installedWorldView.manifest.contentDigest} seed={installedWorldView.manifest.entry.defaultSeed} worldProfile={installedWorldView.profile} isolatedDraft isolatedProjectPatch={installedWorldView.patch as PlanPatchV1 | null} worldScene={installedWorldView} registerProbe={false} onEngineChange={engine => { if (draftCityView && draftCityViewRef.current === draftCityView) draftEngineRef.current = engine; }} onViewportStatus={(status, code) => {
      if (draftCityView) {
        draftViewStatusRef.current = status; draftViewFailureRef.current = code;
        void recordCityDiagnostic(draftCityView, status === "ready" ? "view_ready" : status === "failed" ? "view_failed" : "view_started", code);
        if (status === "ready") onMessage(`独立城市 ${draftCityView.name} 的固定世界包场景已加载；场景碰撞和玩法尚未启用。`);
        else if (status === "failed") onMessage(`独立城市世界包预览失败（${code ?? "content_preview_failed"}）。`);
      } else if (status === "ready") onMessage("世界包只读预览已加载；场景碰撞和玩法尚未启用。");
      else if (status === "failed") onMessage(`世界包预览失败（${code ?? "content_preview_failed"}）。`);
    }} /><div className="viewport-savebar" role="status">{draftCityView ? `独立城市 ${draftCityView.name} · 固定世界包 · 只读预览` : "世界包只读预览"} · 场景碰撞和玩法未启用 <button onClick={onCloseInstalledWorld}>返回项目视图</button></div></div> : draftCityView ? <div className="viewport-frame"><CityViewport key={`${draftCityView.cityId}:${draftCityView.revision}`} seed={draftCityView.seed} worldProfile={draftCityView.profile} isolatedDraft isolatedProjectPatch={(draftCityView.planPatch ?? null) as PlanPatchV1 | null} focusSignal={focusSignal}
      onEngineChange={engine => { if (draftCityViewRef.current === draftCityView) draftEngineRef.current = engine; }}
      onViewportStatus={(status, code) => { if (draftCityViewRef.current === draftCityView) {
        draftViewStatusRef.current = status; draftViewFailureRef.current = code;
        if (status === "ready") { void recordCityDiagnostic(draftCityView, "view_ready"); onMessage(`独立城市 ${draftCityView.name}（版本 ${draftCityView.revision}）已加载，可进行只读预览。`); }
        else if (status === "failed") {
          const safeCode = code?.includes("planning-outcome-failed") ? "planning_outcome_failed" : code?.startsWith("engine_initialization_failed") ? "engine_initialization_failed" : "layout_preparation_failed";
          void recordCityDiagnostic(draftCityView, "view_failed", safeCode); onMessage(`独立城市预览加载失败${code ? `（${code}）` : ""}。`);
        }
      } }} />
      <div className="viewport-savebar" role="status">独立城市只读预览 · {draftCityView.name} · 版本 {draftCityView.revision} <button disabled={busy || browserPreview} onClick={onExportCitySource}>导出城市源码…</button> <button onClick={onCloseDraftCity}>返回项目视图</button></div></div>
      : projectCityKey ? (projectCity?.key !== projectCityKey
        ? <div className="empty viewport-empty">正在读取项目绑定的城市…</div>
        : projectCity.city && isolatedPatchResult && !isolatedPatchResult.ok ? <div className="empty viewport-empty">城市编辑补丁无效或与当前生成器不兼容，无法安全预览。</div>
        : projectCity.city ? <div className="viewport-frame"><CityViewport key={`${projectCityKey}:${projectCity.worldScene?.manifest.contentDigest ?? "generated"}`} seed={projectCity.city.seed} worldProfile={projectCity.city.profile} isolatedDraft isolatedProjectPatch={projectCity.worldScene?.patch as PlanPatchV1 | null ?? (isolatedPatchResult?.ok ? isolatedPatchResult.value as unknown as PlanPatchV1 : null)} worldScene={projectCity.worldScene} focusSignal={focusSignal} onEngineChange={setBaseEngine} onViewportStatus={setBaseStatus} />
          <div className="viewport-savebar" role="status">独立城市只读预览{projectCity.worldScene ? " · 已恢复固定世界包场景" : ""}{projectCity.error ? ` · 世界包场景不可用（${projectCity.error}）` : ""} · 城市编辑尚不可用</div></div>
        : <div className="empty viewport-empty">{projectCity.error}</div>)
      : viewportSeed !== null
      ? <div className="viewport-frame"><CityViewport seed={viewportSeed} worldProfile={worldProfile} editable={!!project} focusSignal={focusSignal}
          projectPatch={(project?.cityPatch ?? null) as PlanPatchV1 | null} onPatchCommit={patch => commitPatchRef.current(patch)}
          onEngineChange={setBaseEngine} onViewportStatus={setBaseStatus} />{!project && <div className="viewport-welcome"><div className="welcome-card"><span className="welcome-kicker">YOUR CITY, YOUR IDEAS</span><h2>从一座城市开始创作</h2><p>打开已有项目，或选择一个玩法模板创建新项目。</p><button onClick={onOpenProject}>创建模板 Game 项目</button></div></div>}</div>
      : <div className="empty viewport-empty">{viewportUnavailable
        ? "当前项目没有绑定的 City 布局快照，视口无法恢复它编辑的城市。请在 City 中重新生成道路地图后新建项目。"
        : "先打开 City 生成道路地图，这里会显示同一座实时城市。"}</div>}</div>
    {agentCityPreview && <div className="viewport-frame viewport-agent-preview"><CityViewport key={agentPreviewId} seed={agentCityPreview.seed} worldProfile={agentCityPreview.profile} isolatedDraft={agentCityPreview.isolated} previewPatch={agentCityPreview.patch} registerProbe={false} focusSignal={focusSignal}
      onViewportStatus={onAgentViewportStatus} />
      <div className="viewport-savebar" role="status">Agent 临时预览 · 不会保存到城市</div></div>}
  </section>;
}
