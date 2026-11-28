import { useColliderViewport } from "../features/preview/useColliderViewport";
import type { AgentColliderPreview } from "../features/preview/sceneColliderPreview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connect, publishToolbar } from "@agent-vitals/app-sdk/ui-host";
import { canonicalJson, completionThresholdOverrides, validateCityInstance, validateCityLayoutSnapshot, validateMiniGamePack, validateMount, validateWorldPlanPatch, type CityGameMountV1, type CityInstanceV1 } from "@oh-agent/city-sdk";
import { buildGameValidation, buildSceneValidation, describeError } from "../sdkValidation";
import { loadStudioAtStartup } from "../startupLoad";
import { forgetStudioProject, projectIdAfterStudioReload, readStoredStudioProject, rememberStudioProject } from "../studioRestore";
import { releaseIdForOpenRevision, type ProjectPublicationV1 } from "../publicationSync";
import { resolveProjectCity } from "../projectCityScope";
import { parseWorldPackageInspection, type WorldPackageInspection } from "../contentPackageInspect";
import { parseInstalledPackages, parseInstallResult, type InstalledContentPackage } from "../installedContent";
import { inspectInstalledWorld, supportsInstalledWorldGenerator } from "../contentSnapshot";
import { buildCitySourceExport, buildProjectSourceExport } from "../projectSourceExport";
import { exportBlockMessage, exportClickBlock } from "../exportClick";
import { AgentApprovalGate, matchesPreviewBase, type AgentCommit } from "../features/agent/agentApproval";
import { useAgentActivity } from "../features/agent/useAgentActivity";
import { AgentWorkspace } from "../features/agent/AgentWorkspace";
import { useStudioTasks, type TaskScope } from "../features/agent/useStudioTasks";
import { useWorkspaceFocusCycling } from "../features/workspace/workspaceFocus";
import { taskCommitBlockedReason, taskHasSceneObjectPreview } from "../features/agent/taskCommit";
import { useCreatorHostBridge } from "./useCreatorHostBridge";
import { CodeGamePreviewPanel } from "../features/preview/CodeGamePreviewPanel";
import { mountChoices, mountSlotLabel } from "../features/project/mountEditorModel";
import { WorkspaceContentDrawer } from "../features/preview/WorkspaceContentDrawer";
import { WorkspacePreview } from "../features/preview/WorkspacePreview";
import { workspaceNextStep, type WorkspaceAction } from "../features/preview/workspaceNextStep";
import type { ReleaseRef } from "../contracts/creatorProject";
import { layoutSelectionKey, type CityDiagnosticContext, type CityRow, type CityViewOpenResult, type CityViewStatus, type CityWorldSnapshot, type LayoutRow, type Project, type ProjectCityState, type ProjectRow, type SceneDraft, type StudioPanel } from "../contracts/creatorStudio";
import { browserPreview, creatorRequest } from "../adapters/creatorHost";
import { digest, errorCode } from "../adapters/creatorHostUtils";
import { CityGameLibraryPanel } from "../features/library/CityGameLibraryPanel";
import { CityViewportPanel, type PreviewViewportSource } from "../features/city/CityViewportPanel";
import { CityDraftPanel } from "../features/city/CityDraftPanel";
import { CityArchivePanel } from "../features/city/CityArchivePanel";
import { canCommitArchive, cityDraftValidation, DRAFT_CITY_PROFILE, parseArchivePreview, parseArchivedCities, parseCityDraft, type ArchivedCity, type CityArchivePreview, type CityDraft } from "../contracts/cityLifecycle";
import { GameEditorPanel, type EditorFocusTarget } from "../features/project/GameEditorPanel";
import { ProjectPanel } from "../features/project/ProjectPanel";
import { CatalogStart, type CatalogStartMode } from "../features/project/CatalogStart";
import { GameStartForm } from "../features/project/GameStartForm";
import { ProjectsPage } from "../features/project/ProjectsPage";
import { WorkbenchHome } from "../features/home/WorkbenchHome";
import { StoryEditorPanel } from "../features/story/StoryEditorPanel";
import { EvidenceCenterPanel } from "../features/evidence/EvidenceCenterPanel";
import { ExperienceDistributionPanel } from "../features/distribution/ExperienceDistributionPanel";
import { CandidatePanel } from "../features/project/CandidatePanel";
import { canAcceptCandidate, parseProjectCandidate, type ProjectCandidate } from "../contracts/candidate";
import { normalizeStudioGoal } from "../contracts/studioTask";
import { STUDIO_NAVIGATION, STUDIO_PROJECTS_ROUTE, STUDIO_WORKSPACE_ROUTE, studioRouteTitle, type StudioRoute } from "./studioRoute";
import { readCityAppearancePreference } from "../../../../agent-city/ui/src/engine/cityWorldProfile";
import type { CityEngine, CityEntitySelection } from "../../../../agent-city/ui/src/engine/CityEngine";
import { attachPreviewEntitySupport, entityVerificationLevel, parsePreviewEntityReference, previewEntityReferenceStatus, type PreviewEntityReference, type PreviewEntityScope } from "../contracts/previewContext";
import { parseGroundInspection } from "../features/evidence/evidenceCenterModel";
import { idlePreviewEntityDiagnostic, type PreviewEntityDiagnosticState } from "../features/preview/PreviewEntityContext";
import { useProjectSceneAssets } from "../features/preview/useProjectSceneAssets";
import { useAgentScenePreview } from "../features/preview/useAgentScenePreview";
import { composeProjectSceneView } from "../features/preview/projectSceneView";
import { CITY_GENERATOR_VERSION, type PlanPatchV1 } from "../../../../agent-city/ui/src/engine/planPatch";
import { SessionSidebar } from "../features/session/SessionSidebar";
import { useStudioSessions } from "../features/session/useStudioSessions";
import { useWorkspaceLayout } from "../features/workspace/useWorkspaceLayout";
import { WorkspaceSplitter } from "../features/workspace/WorkspaceSplitter";
import { WORKSPACE_MIN_AGENT, WORKSPACE_MIN_SESSIONS } from "../features/workspace/workspaceLayout";

function bindingsMatch(text: string, saved: Record<string, string[]>): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const normalize = (value: Record<string, unknown>) => Object.fromEntries(
      Object.entries(value).filter(([, entry]) => !Array.isArray(entry) || entry.length > 0),
    );
    return canonicalJson(normalize(parsed as Record<string, unknown>)) === canonicalJson(normalize(saved));
  } catch {
    return false;
  }
}

export function CreatorStudioApp() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState("");
  const [layouts, setLayouts] = useState<LayoutRow[]>([]);
  // 世界外观偏好与 City 同源（同源 WebView 共享 localStorage）；打开期间不追踪 City 侧更改。
  const [worldProfile] = useState(() => readCityAppearancePreference());
  const [project, setProject] = useState<Project | null>(null);
  const [projectCity, setProjectCity] = useState<ProjectCityState | null>(null);
  const [draftCityView, setDraftCityView] = useState<CityInstanceV1 | null>(null);
  const [installedWorldView, setInstalledWorldView] = useState<CityWorldSnapshot | null>(null);
  const draftCityViewRef = useRef<CityInstanceV1 | null>(null);
  const cityOpenRequest = useRef(0);
  const draftEngineRef = useRef<CityEngine | null>(null);
  const draftViewStatusRef = useRef<CityViewStatus>("loading");
  const draftViewFailureRef = useRef<string | undefined>(undefined);
  const draftDiagnosticsRef = useRef<CityDiagnosticContext | null>(null);
  const recordCityDiagnostic = async (city: CityInstanceV1, event: string, code?: string) => {
    const context = draftDiagnosticsRef.current;
    if (!context || context.cityId !== city.cityId || context.revision !== city.revision) return;
    try {
      await creatorRequest("creator.city.diagnostic.record", { cityId: city.cityId, revision: city.revision, correlationId: context.correlationId,
        event, ...(code ? { code } : {}), elapsedMs: Math.min(86_400_000, Math.max(0, Math.round(performance.now() - context.started))) });
    } catch { context.unavailable = true; }
  };
  const [text, setText] = useState("");
  const [sceneText, setSceneText] = useState('{\n  "schemaVersion": 1,\n  "objects": []\n}');
  const [entryAnchorId, setEntryAnchorId] = useState("");
  const [bindingsText, setBindingsText] = useState("{}");
  const [skinId, setSkinId] = useState("miami-vice");
  const [template, setTemplate] = useState("checkpoint-race");
  const [worldRevision, setWorldRevision] = useState("");
  // 视口必须显示当前项目绑定的那座城市：已打开项目直接取其快照里的 seed；
  // 未打开项目时取「新建」里选中的布局版本。布局列表是有界目录（最多 8 条），
  // 选中的版本不在其中时诚实降级为提示，绝不回退到最新布局冒充当前城市。
  const viewportSeed: number | null =
    project?.cityLayout?.seed ?? (worldRevision ? layouts.find(layout => layoutSelectionKey(layout) === worldRevision)?.seed ?? null : null);
  const viewportUnavailable = project !== null && !project.cityLayout;
  const projectCityKey = project?.cityId ? `${project.cityId}:${project.cityRevision}` : null;
  useEffect(() => {
    if (!projectCityKey || !project?.cityId) { setProjectCity(null); return; }
    let cancelled = false;
    setProjectCity(null);
    void creatorRequest<unknown>("creator.city.read", { cityId: project.cityId, revision: project.cityRevision }).then(raw => {
      const city = resolveProjectCity(raw, { cityId: project.cityId!, cityRevision: project.cityRevision, seed: project.cityLayout?.seed });
      if (!city) throw new Error("creator_city_revision_unavailable");
      const loadWorldScene = async (): Promise<CityWorldSnapshot | undefined> => {
        const linked = await creatorRequest<unknown>("creator.city.world_package.read", { cityId: city.cityId });
        if (!linked || typeof linked !== "object" || !Object.hasOwn(linked, "worldPackage") || Object.keys(linked).length !== 1) throw new Error("content_snapshot_invalid");
        const reference = (linked as Record<string, unknown>).worldPackage;
        if (reference === null) return undefined;
        if (!reference || typeof reference !== "object" || Array.isArray(reference) || Object.keys(reference).length !== 3) throw new Error("content_snapshot_invalid");
        const itemRef = reference as Record<string, unknown>;
        if (typeof itemRef.packageId !== "string" || typeof itemRef.version !== "string" || typeof itemRef.contentDigest !== "string") throw new Error("content_snapshot_invalid");
        const available = parseInstalledPackages(await creatorRequest<unknown>("creator.content.list", {})) ?? [];
        const item = available.find(candidate => candidate.packageId === itemRef.packageId && candidate.version === itemRef.version && candidate.contentDigest === itemRef.contentDigest);
        if (!item) throw new Error("content_package_not_found");
        const world = await inspectInstalledWorld(creatorRequest, item);
        if (!("defaultSeed" in world.manifest.entry) || !supportsInstalledWorldGenerator(world.manifest)) throw new Error("content_city_binding_mismatch");
        return world;
      };
      void loadWorldScene().then(worldScene => { if (!cancelled) setProjectCity({ key: projectCityKey, city, ...(worldScene ? { worldScene } : {}) }); })
        .catch(error => { if (!cancelled) setProjectCity({ key: projectCityKey, city, error: errorCode(error, "content_snapshot_invalid") }); });
    }).catch(() => { if (!cancelled) setProjectCity({ key: projectCityKey, city: null, error: "项目绑定的城市版本不可用，请重新生成并绑定对应布局。" }); });
    return () => { cancelled = true; };
  }, [projectCityKey, project?.cityId, project?.cityRevision, project?.cityLayout?.seed]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<"game" | "scene" | "mount" | "skin" | null>(null);
  const [publishedReleaseId, setPublishedReleaseId] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<ProjectCandidate | null>(null);
  const [candidateRead, setCandidateRead] = useState<"loading" | "ready" | "unavailable">("loading");
  const [editorFocus, setEditorFocus] = useState<EditorFocusTarget | null>(null);
  const [packageInspection, setPackageInspection] = useState<WorldPackageInspection | null>(null);
  const [installedPackages, setInstalledPackages] = useState<ReadonlyArray<InstalledContentPackage>>([]);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [route, setRoute] = useState<StudioRoute>(STUDIO_PROJECTS_ROUTE);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogStartMode, setCatalogStartMode] = useState<CatalogStartMode>(null);
  const [activePanel, setActivePanel] = useState<StudioPanel>("agent");
  const [contentOpen, setContentOpen] = useState(false);
  const openWorkspacePanel = (panel: StudioPanel) => {
    setActivePanel(panel);
    setContentOpen(panel !== "agent");
    setRoute(STUDIO_WORKSPACE_ROUTE);
  };
  const [storyTool, setStoryTool] = useState<{ storyId?: string } | null>(null);
  const [storyHasDraft, setStoryHasDraft] = useState(false);
  const [storyAgentSlot, setStoryAgentSlot] = useState<HTMLDivElement | null>(null);
  const openStoryTool = (storyId?: string) => {
    setStoryTool(current => storyId === undefined ? current ?? {} : { storyId });
    openWorkspacePanel("story");
  };
  const [codePreviewBuildId, setCodePreviewBuildId] = useState<string | undefined>(undefined);
  const [codePreviewSourceCityId, setCodePreviewSourceCityId] = useState<string | undefined>(undefined);
  const openCodeGamePreview = (buildId: string, cityId?: string) => {
    setCodePreviewBuildId(buildId);
    setCodePreviewSourceCityId(cityId);
    openWorkspacePanel("code");
  };
  const [message, setMessage] = useState("");
  const [goalDraft, setGoalDraft] = useState("");
  const [projectGoals, setProjectGoals] = useState<ReadonlyMap<string, string>>(() => new Map());
  const updateProjectGoal = (projectId: string, goal: string) =>
    setProjectGoals(current => new Map(current).set(projectId, goal));
  const [cityGoals, setCityGoals] = useState<ReadonlyMap<string, string>>(() => new Map());
  const updateCityGoal = (cityId: string, goal: string) =>
    setCityGoals(current => new Map(current).set(cityId, goal));
  const [cities, setCities] = useState<CityRow[]>([]);
  const [citiesCursor, setCitiesCursor] = useState<string | null>(null);
  const [citiesLoading, setCitiesLoading] = useState(false);
  const [citiesError, setCitiesError] = useState(false);
  const [cityDraft, setCityDraft] = useState<CityDraft | null>(null);
  const [cityDraftOperationId, setCityDraftOperationId] = useState<string | null>(null);
  const [archivePreview, setArchivePreview] = useState<CityArchivePreview | null>(null);
  const [archivedCities, setArchivedCities] = useState<readonly ArchivedCity[]>([]);
  const [archivesLoading, setArchivesLoading] = useState(true);
  const [archivesError, setArchivesError] = useState("");
  const cityListRequest = useRef(0);
  const archiveListRequest = useRef(0);
  const loadCities = async (cursor?: string) => {
    const request = ++cityListRequest.current;
    setCitiesLoading(true); setCitiesError(false);
    try {
      const result = await creatorRequest<{ cities: CityRow[]; nextCursor: string | null }>("creator.city.list", { limit: 50, ...(cursor ? { cursor } : {}) });
      if (request !== cityListRequest.current) return;
      setCities(previous => cursor ? [...previous, ...result.cities.filter(city => !previous.some(item => item.cityId === city.cityId))] : result.cities);
      setCitiesCursor(result.nextCursor);
    } catch { if (request === cityListRequest.current) setCitiesError(true); }
    finally { if (request === cityListRequest.current) setCitiesLoading(false); }
  };
  const loadArchivedCities = async () => {
    const request = ++archiveListRequest.current;
    setArchivesLoading(true); setArchivesError("");
    try {
      const cities = parseArchivedCities(await creatorRequest<unknown>("creator.city.archive.list", {}));
      if (request === archiveListRequest.current) setArchivedCities(cities);
    } catch (error) {
      if (request === archiveListRequest.current) setArchivesError(errorCode(error, "creator_archive_list_unavailable"));
    } finally { if (request === archiveListRequest.current) setArchivesLoading(false); }
  };
  useEffect(() => {
    if (route.section !== "projects" && (route.section !== "workspace" || activePanel !== "project")) return;
    void loadCities();
    void loadArchivedCities();
    const changed = () => { void loadCities(); void loadArchivedCities(); };
    window.addEventListener("__CREATOR_CITY_CHANGED__", changed);
    return () => { cityListRequest.current++; archiveListRequest.current++; window.removeEventListener("__CREATOR_CITY_CHANGED__", changed); };
  }, [activePanel, route.section]);
  // 未完成操作的幂等标识：结果确定前保留，响应失败时用于重试与状态查询。
  const [pendingEdit, setPendingEdit] = useState<{ projectId: string; operationId: string } | null>(null);
  const [pendingCreateId, setPendingCreateId] = useState<string | null>(null);
  const { agentActivity, recordAgentActivity, restoreAgentActivity } = useAgentActivity(creatorRequest);
  const projectTaskScope = project ? { kind: "creator-project" as const, projectId: project.projectId, revision: project.revision } : null;
  // 任务构件跟随当前打开的对象：独立 City 只读预览打开时，Agent 任务针对 City。
  const cityTaskScope = draftCityView ? { kind: "creator-city" as const, cityId: draftCityView.cityId, revision: draftCityView.revision } : null;
  const taskScope = cityTaskScope ?? projectTaskScope;
  const sessionScope = taskScope?.kind === "creator-project" ? { kind: "creator-project" as const, projectId: taskScope.projectId }
    : taskScope?.kind === "creator-city" ? { kind: "creator-city" as const, cityId: taskScope.cityId } : null;
  const studioSessions = useStudioSessions(creatorRequest, sessionScope, !browserPreview);
  const activeSessionId = studioSessions.activeSessionId;
  const previewResetScope = JSON.stringify([taskScope, projectCityKey]);
  const selectionScope = taskScope ? JSON.stringify([taskScope, projectCityKey, activeSessionId]) : "";
  const [selection, setSelection] = useState<{ scope: string; target: string; reference?: PreviewEntityReference } | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selectedEntitySource = useRef<PreviewViewportSource>("base");
  const [entityDiagnostic, setEntityDiagnostic] = useState<PreviewEntityDiagnosticState>(idlePreviewEntityDiagnostic);
  const agentPreviewEngineRef = useRef<CityEngine | null>(null);
  const selectedEntity = selection?.scope === selectionScope ? selection.reference ?? null : null;
  useEffect(() => { setSelection(null); setEntityDiagnostic(idlePreviewEntityDiagnostic); }, [selectionScope, route.section, installedWorldView]);
  // 单一任务控制器按活动工件切换 scope：Story 工具打开时整条链路（订阅、任务、
  // 历史）切到 story 工件，杜绝 Story 面板自建第二套会话逻辑。PR14：从模板创建
  // Code Game 工作区后任务链路切到该工作区（workspaceId + 内容摘要 revision，
  // PR10 合同）；scope 仅在会话内保持，跨重启恢复列为 PR14 残留（workspace
  // 摘要随内容变化，无列表工具时不做静默重绑）。
  const [storyTaskScope, setStoryTaskScope] = useState<TaskScope>(null);
  const storyTaskActive = activePanel === "story" && !!storyTool;
  const [codeGameWorkspace, setCodeGameWorkspace] = useState<{ workspaceId: string; projectId: string; gameId: string; gameRevision: string; template: string } | null>(null);
  const codeGameTaskScope: TaskScope = codeGameWorkspace
    ? { kind: "code-game", workspaceId: codeGameWorkspace.workspaceId, revision: codeGameWorkspace.gameRevision }
    : null;
  const activeTaskScope = storyTaskActive ? storyTaskScope : codeGameTaskScope ?? taskScope;
  const studioTasks = useStudioTasks(creatorRequest, activeTaskScope,
    !browserPreview && (storyTaskActive ? true : !!activeSessionId),
    storyTaskActive ? false : !!(draftCityView || projectCityKey),
    storyTaskActive ? null : activeSessionId,
    executor => { void studioSessions.savePreferredExecutor(executor); });
  // 会话档案里的首选执行器只在"切进这个会话"时回填一次；回填不写回 Host，
  // 否则每次切换都会把默认值当成用户偏好存下来。
  const appliedExecutorSession = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSessionId) { appliedExecutorSession.current = null; return; }
    if (appliedExecutorSession.current === activeSessionId || !studioTasks.capabilities) return;
    appliedExecutorSession.current = activeSessionId;
    const preferred = studioSessions.activeSession?.preferredExecutor ?? "";
    const usable = studioTasks.capabilities.executors.filter(item => item.available && item.modes.some(mode => mode.restricted));
    studioTasks.applyPreferredExecutor(preferred && usable.some(item => item.id === preferred) ? preferred : "");
  }, [activeSessionId, studioSessions.activeSession?.preferredExecutor, studioTasks.capabilities]);
  // 三栏宽度按 Project/City 记住（设计基线 §1）：布局是本机偏好，不进 Host 会话档案。
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const workspaceLayout = useWorkspaceLayout(workspaceRef, draftCityView?.cityId ?? project?.projectId ?? "");
  // F6 / Shift+F6 在 Sessions、Preview、Agent 三个命名区域间循环焦点。
  useWorkspaceFocusCycling();
  useEffect(() => {
    if (!activeSessionId || !studioTasks.task) return;
    void studioSessions.refresh().catch(() => undefined);
  }, [activeSessionId, studioTasks.task?.taskId, studioTasks.task?.phase, studioSessions.refresh]);
  const approvalGate = useRef(new AgentApprovalGate());
  const [agentCommit, setAgentCommit] = useState<AgentCommit | null>(null);
  const [agentPreviewStatus, setAgentPreviewStatus] = useState<{ context: object; status: "loading" | "ready" | "failed"; code?: string } | null>(null);
  const [agentRevealSignal, setAgentRevealSignal] = useState(0);
  // 窄屏（≤800px）不三栏堆叠：Sessions 折叠成抽屉，按需打开（设计原则：先折叠 Sessions）。
  const [narrowSessionsOpen, setNarrowSessionsOpen] = useState(false);
  useEffect(() => {
    if (!agentCommit) return;
    const timer = window.setTimeout(() => {
      approvalGate.current.clear(agentCommit);
      setAgentCommit(current => current === agentCommit ? null : current);
      setMessage("Agent 预览已过期，请重新预览后提交。");
    }, Math.max(0, agentCommit.proposal.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [agentCommit]);
  // ── 草稿保护：每个编辑区域（规则/场景/挂载/皮肤）的草稿 = 当前输入 ≠ 上次同步的已保存值。
  // preserve：保留有草稿区域的本地输入（草稿基于新 revision 重新校验后提交），同步无草稿区域；
  // replace：重置全部表单（显式切换/新建项目），丢弃前在状态区明确告知。
  const savedForms = (p: Project) => ({
    game: JSON.stringify(p.game, null, 2),
    scene: JSON.stringify(p.scene ?? { schemaVersion: 1, objects: [] }, null, 2),
    bindings: JSON.stringify(p.mounts?.[0]?.bindings ?? {}, null, 2),
    entry: p.mounts?.[0]?.entryAnchorId ?? mountChoices(p.cityLayout?.layout, p.game).entries[0]?.id ?? "",
    skin: p.skinId ?? "miami-vice",
  });
  const dirtyRegions = (p: Project) => {
    const saved = savedForms(p);
    return {
      game: text !== saved.game,
      scene: sceneText !== saved.scene,
      mount: !bindingsMatch(bindingsText, p.mounts?.[0]?.bindings ?? {}) || entryAnchorId !== saved.entry,
      skin: skinId !== saved.skin,
    };
  };
  const hasDrafts = (p: Project | null) => p !== null && Object.values(dirtyRegions(p)).some(Boolean);
  const publicationEpoch = useRef(0);
  const candidateEpoch = useRef(0);
  const syncPublicationRef = useRef<(projectId: string, revision: number) => void>(() => {});
  const syncCandidateRef = useRef<(projectId: string, revision: number) => void>(() => {});
  const applyProject = (next: Project, mode: "preserve" | "replace", previous: Project | null) => {
    const sameProject = previous !== null && previous.projectId === next.projectId;
    const dirty = sameProject ? dirtyRegions(previous) : null;
    const saved = savedForms(next);
    // 换了项目或修订先清掉上一份 release，避免试玩按钮指向别的版本；
    // 同一修订保留，等下面的权威查询确认或补上已发布的 release。
    if (!sameProject || previous?.revision !== next.revision) { setPublishedReleaseId(null); setCandidate(null); setCandidateRead("loading"); }
    setProject(next);
    syncPublicationRef.current(next.projectId, next.revision);
    syncCandidateRef.current(next.projectId, next.revision);
    setText(dirty?.game ? text : saved.game);
    setSceneText(dirty?.scene ? sceneText : saved.scene);
    setBindingsText(dirty?.mount ? bindingsText : saved.bindings);
    setEntryAnchorId(dirty?.mount ? entryAnchorId : saved.entry);
    setSkinId(dirty?.skin ? skinId : saved.skin);
    setPreviewId(null); setPreviewKind(null);
    if (mode === "replace" && hasDrafts(previous)) setMessage("已切换项目；之前项目的未提交草稿已丢弃。");
    return { preservedDrafts: mode === "preserve" && !!dirty && Object.values(dirty).some(Boolean) };
  };
  // 宿主事件与异步回调持有旧渲染的闭包；经 ref 始终调用最新实现，否则用户刚
  // 输入的草稿会被旧闭包里的旧文本误判为「无草稿」而被覆盖。
  const applyRef = useRef(applyProject);
  applyRef.current = applyProject;
  // 视口引擎实例（creator.scene.capture 从这里取帧）；projectRef 供宿主转发的
  // 处理器读取当前 revision（handlers effect 的闭包是空依赖，拿不到新 state）。
  const studioEngineRef = useRef<CityEngine | null>(null);
  const [baseViewport, setBaseViewport] = useState<{ engine: CityEngine | null; status: "loading" | "ready" | "failed" }>({ engine: null, status: "loading" });
  const isolatedProjectEngineRef = useRef<CityEngine | null>(null);
  const baseViewportStatusRef = useRef<"loading" | "ready" | "failed">("loading");
  const setBaseEngine = (engine: CityEngine | null, isolated = false) => {
    isolatedProjectEngineRef.current = isolated ? engine : null;
    baseViewportStatusRef.current = "loading";
    studioEngineRef.current = engine;
    setBaseViewport({ engine, status: "loading" });
  };
  const setBaseStatus = (status: "loading" | "ready" | "failed") => {
    baseViewportStatusRef.current = status;
    const engine = studioEngineRef.current;
    setBaseViewport(previous => previous.engine === engine && previous.status === status ? previous : { engine, status });
  };
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project;
  syncPublicationRef.current = (projectId, revision) => {
    const epoch = ++publicationEpoch.current;
    void creatorRequest<ProjectPublicationV1>("creator.project.publication", { projectId, revision }).then(publication => {
      if (epoch !== publicationEpoch.current) return;
      const current = projectRef.current;
      if (current && (current.projectId !== projectId || current.revision !== revision)) return;
      setPublishedReleaseId(releaseIdForOpenRevision(publication, projectId, revision));
    }).catch(() => {
      if (epoch !== publicationEpoch.current) return;
      const current = projectRef.current;
      if (current && (current.projectId !== projectId || current.revision !== revision)) return;
      setPublishedReleaseId(null);
    });
  };
  syncCandidateRef.current = (projectId, revision) => {
    const epoch = ++candidateEpoch.current;
    void creatorRequest<unknown>("creator.project.candidate.read", { projectId, revision }).then(raw => {
      if (epoch !== candidateEpoch.current) return;
      const current = projectRef.current;
      if (current && (current.projectId !== projectId || current.revision !== revision)) return;
      const next = parseProjectCandidate(raw);
      if (next && (next.projectId !== projectId || next.revision !== revision)) throw new Error("creator_candidate_scope_mismatch");
      setCandidate(next);
      setCandidateRead("ready");
    }).catch(() => {
      if (epoch !== candidateEpoch.current) return;
      const current = projectRef.current;
      if (current && (current.projectId !== projectId || current.revision !== revision)) return;
      setCandidate(null);
      setCandidateRead("unavailable");
    });
  };
  useEffect(() => {
    if (candidate?.status !== "testing") return;
    const timer = window.setInterval(() => syncCandidateRef.current(candidate.projectId, candidate.revision), 2_000);
    return () => window.clearInterval(timer);
  }, [candidate?.status, candidate?.projectId, candidate?.revision]);
  // 发生版本冲突时保留本地状态并要求重新预览，不能用旧补丁覆盖新版本。
  const commitCityPatch = (patch: PlanPatchV1) => {
    void (async () => {
      const current = projectRef.current;
      if (!current) return;
      const operationId = `patch:${crypto.randomUUID()}`;
      try {
        const operations = [{ op: "city.patch.upsert", patch }];
        const preview = await creatorRequest<{ previewId: string }>("creator.scene.preview", {
          projectId: current.projectId, baseRevision: current.revision, operations,
          validation: await buildSceneValidation(current, current.projectId, current.revision, operations),
        });
        await creatorRequest("creator.scene.commit", { projectId: current.projectId, previewId: preview.previewId, expectedRevision: current.revision, operationId });
        const updated = await creatorRequest<Project>("creator.project.read", { projectId: current.projectId });
        applyRef.current(updated, "preserve", current);
        setMessage(`城市修改已写入项目（revision ${updated.revision}）。`);
      } catch (error) {
        const code = error instanceof Error ? error.message : "creator_patch_commit_failed";
        setMessage(code === "revision_conflict"
          ? "项目版本已变化，城市修改未写入项目。请重新打开项目并重新预览。"
          : `项目补丁写入失败（${code}）；城市视图保留本地修改。`);
      }
    })();
  };
  const commitPatchRef = useRef(commitCityPatch);
  commitPatchRef.current = commitCityPatch;
  // 离开当前项目（切换项目行/新建）前先确认：有未提交草稿时第一次点击只提示，
  // 第二次点击才真正丢弃——提示先于丢弃，而不是丢弃后补一句。
  const [switchConfirm, setSwitchConfirm] = useState<string | null>(null);
  const switchTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(switchTimer.current), []);
  // 打开/切回项目后让视口回到全局视角（CityViewport 收到递增信号即 resetView）。
  const [focusSignal, setFocusSignal] = useState(0);
  const guardDrafts = (target: string, proceed: () => void) => {
    if (!hasDrafts(project) || switchConfirm === target) {
      window.clearTimeout(switchTimer.current);
      setSwitchConfirm(null);
      proceed();
      return;
    }
    setSwitchConfirm(target);
    setMessage("当前项目有未提交草稿；再次点击确认丢弃并继续。");
    window.clearTimeout(switchTimer.current);
    switchTimer.current = window.setTimeout(() => setSwitchConfirm(null), 5000);
  };
  const openProjectInWorkspace = (projectId: string, goal?: string, focus?: "mount") => {
    const enter = () => {
      if (goal !== undefined) updateProjectGoal(projectId, goal);
      setCatalogStartMode(null);
      if (focus) setEditorFocus(focus);
      openWorkspacePanel(focus ? "play" : "agent");
    };
    if (project?.projectId === projectId && !draftCityView && !installedWorldView) {
      enter();
      return;
    }
    guardDrafts(projectId, () => {
      void openProject(projectId).then(opened => { if (opened) enter(); });
    });
  };
  const openAgentProjectFromCatalog = (projectId: string) => {
    if (normalizeStudioGoal(goalDraft)) openProjectInWorkspace(projectId, goalDraft);
  };
  const openCityInWorkspace = (cityId: string, revision: number) => {
    const open = () => {
      setBusy(true); setMessage("");
      void openCityView(cityId, revision).then(() => {
        setProject(null); setProjectCity(null);
        openWorkspacePanel("agent");
      }).catch(error => {
        const code = errorCode(error, "creator_city_view_failed");
        setMessage(code === "revision_conflict" ? "城市版本已变化，请刷新列表后重新打开。" : `无法打开城市（${code}）。`);
        void loadCities();
      }).finally(() => setBusy(false));
    };
    guardDrafts(`city:${cityId}`, open);
  };
  const refreshProjectCatalog = () => {
    void refresh().catch(error => setMessage(describeError(error, "creator_refresh_failed")));
  };
  const refresh = useCallback(async () => {
    setProjectsLoading(true); setProjectsError("");
    try {
      const [response, layoutResponse] = await Promise.all([
        creatorRequest<{ projects: ProjectRow[] }>("creator.project.list", { limit: 50 }),
        creatorRequest<{ layouts: LayoutRow[]; cityLayouts?: LayoutRow[] }>("creator.layout.list", { limit: 8 }),
      ]);
      setProjects(response.projects);
      const availableLayouts = [...layoutResponse.layouts, ...(layoutResponse.cityLayouts ?? [])];
      setLayouts(availableLayouts);
      setWorldRevision(current => availableLayouts.some(layout => layoutSelectionKey(layout) === current) ? current : availableLayouts[0] ? layoutSelectionKey(availableLayouts[0]) : "");
    } catch (error) {
      setProjectsError(describeError(error, "creator_load_failed"));
      throw error;
    } finally { setProjectsLoading(false); }
  }, []);
  const createCityDraft = async (name: string, seed: number) => {
    setBusy(true); setMessage("");
    const createOperationId = `city-draft-create:${crypto.randomUUID()}`;
    try {
      const validation = await cityDraftValidation(name, seed, createOperationId);
      const draft = parseCityDraft(await creatorRequest<unknown>("creator.city.draft.create", { name, seed, profile: DRAFT_CITY_PROFILE, operationId: createOperationId, validation }));
      setCityDraft(draft);
      setCityDraftOperationId(`city-draft-commit:${crypto.randomUUID()}`);
      setMessage("City 草稿已创建，尚未注册到正常 City 列表；首次保存才会注册。取消或过期不会留下 City。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_city_draft_create_failed"); }
    finally { setBusy(false); }
  };
  // PR14 模板创建真实链路：Code Game 卡片"以此创建"直达宿主行
  // creator.code.project.create（实现复用 MCP crate，同一份 PR02 operationId
  // 回执与工作区目录——与 Agent 调 creator_code_project_create 完全同一条链）。
  // 成功后任务链路切到该工作区（code-game scope）。
  const createCodeGame = async (templateId: string) => {
    setBusy(true); setMessage("");
    // MCP creator_code_project_create 的 operationId 词表不允许 `:`（回执文件名防注入），
    // 与宿主 valid_id 词表不同——统一用连字符前缀。
    const operationId = `code-create-${crypto.randomUUID()}`;
    try {
      const created = await creatorRequest<{ workspaceId: string; projectId: string; gameId: string; gameRevision: string }>(
        "creator.code.project.create", { template: templateId, operationId, title: templateId });
      setCodeGameWorkspace({ ...created, template: templateId });
      setMessage(`Code Game 工作区已创建（${created.workspaceId}）；Agent 任务链路已切换到该工作区。`);
      // PR14 收官：创建后直接进入工作区面板（构建/预览入口），不再停留在目录页。
      // 缺陷⑤修复：仅 setActivePanel 不会离开项目库路由页——必须同时切 route 到
      // workspace（openWorkspacePanel 只切工作区内部面板）。
      setRoute(STUDIO_WORKSPACE_ROUTE);
      openWorkspacePanel("code");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_code_create_failed"); }
    finally { setBusy(false); }
  };
  // PR14 Remix 真实入口：已接受 Release 一键克隆为新可编辑草稿（宿主
  // creator.project.remix 幂等回执；remixSource 保留来源）。成功后刷新项目
  // 列表并打开新草稿。
  const remixRelease = async (releaseId: string) => {
    setBusy(true); setMessage("");
    const operationId = `remix-${crypto.randomUUID()}`;
    try {
      const remixed = await creatorRequest<{ projectId: string }>("creator.project.remix", { sourceReleaseId: releaseId, operationId });
      await refreshProjectCatalog();
      setMessage(`已从 ${releaseId} Remix 出新草稿 ${remixed.projectId}。`);
      openProjectInWorkspace(remixed.projectId);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_remix_failed"); }
    finally { setBusy(false); }
  };
  const commitCityDraft = async () => {
    if (!cityDraft || !cityDraftOperationId || cityDraft.status !== "pending") return;
    setBusy(true); setMessage("");
    try {
      const validation = await cityDraftValidation(cityDraft.name, cityDraft.seed, cityDraftOperationId);
      const registered = await creatorRequest<{ cityId: string; revision: number }>("creator.city.draft.commit", { draftId: cityDraft.draftId, operationId: cityDraftOperationId, validation });
      setCityDraft(null); setCityDraftOperationId(null);
      await Promise.all([loadCities(), loadArchivedCities()]);
      await openCityView(registered.cityId, registered.revision);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_city_draft_commit_failed"); }
    finally { setBusy(false); }
  };
  const cancelCityDraft = async () => {
    if (!cityDraft || cityDraft.status !== "pending") return;
    setBusy(true); setMessage("");
    try {
      await creatorRequest("creator.city.draft.cancel", { draftId: cityDraft.draftId, operationId: `city-draft-cancel:${crypto.randomUUID()}` });
      setCityDraft(null); setCityDraftOperationId(null);
      setMessage("已取消 City 草稿；没有注册 City。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_city_draft_cancel_failed"); }
    finally { setBusy(false); }
  };
  const previewCityArchive = async (city: CityRow) => {
    setBusy(true); setMessage(""); setArchivePreview(null);
    try {
      const preview = parseArchivePreview(await creatorRequest<unknown>("creator.city.archive.preview", {
        cityId: city.cityId, expectedCityRevision: city.revision, operationId: `city-archive-preview:${crypto.randomUUID()}`,
      }));
      setArchivePreview(preview);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_archive_preview_failed"); }
    finally { setBusy(false); }
  };
  const commitCityArchive = async () => {
    if (!archivePreview || !canCommitArchive(archivePreview, true)) return;
    setBusy(true); setMessage("");
    try {
      await creatorRequest("creator.city.archive.commit", { previewId: archivePreview.previewId, operationId: `city-archive-commit:${crypto.randomUUID()}`, dependencyDigest: archivePreview.dependencyDigest });
      if (draftCityView?.cityId === archivePreview.cityId) { cityOpenRequest.current++; draftCityViewRef.current = null; setDraftCityView(null); }
      setArchivePreview(null);
      await Promise.all([loadCities(), loadArchivedCities()]);
      setMessage("City 已归档；作品、安装关系、历史 Release/Candidate、Revision 和世界包均保留，可在归档列表恢复。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_archive_commit_failed"); }
    finally { setBusy(false); }
  };
  const restoreCityArchive = async (cityId: string) => {
    setBusy(true); setMessage("");
    try {
      await creatorRequest("creator.city.archive.restore", { cityId, operationId: `city-archive-restore:${crypto.randomUUID()}` });
      await Promise.all([loadCities(), loadArchivedCities()]);
      setMessage("City 已恢复到正常列表；原有作品和历史未改变。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_archive_restore_failed"); }
    finally { setBusy(false); }
  };
  const openCityView = async (cityId: string, revision: number): Promise<CityViewOpenResult> => {
    setInstalledWorldView(null); setDraftCityView(null);
    if (typeof cityId !== "string" || !Number.isSafeInteger(revision) || revision < 0) throw new Error("creator_request_invalid");
    const request = ++cityOpenRequest.current;
    const document = await creatorRequest<unknown>("creator.city.read", { cityId });
    if (request !== cityOpenRequest.current) throw new Error("creator_city_view_superseded");
    const checked = validateCityInstance(document);
    if (!checked.ok) throw new Error("creator_city_invalid");
    if (checked.value.cityId !== cityId || checked.value.revision !== revision) throw new Error("revision_conflict");
    if (checked.value.planPatch && !validateWorldPlanPatch(checked.value.planPatch, checked.value.seed, CITY_GENERATOR_VERSION).ok) throw new Error("creator_city_patch_incompatible");
    const linked = await creatorRequest<unknown>("creator.city.world_package.read", { cityId });
    let linkedWorld: Awaited<ReturnType<typeof inspectInstalledWorld>> | null = null;
    if (!linked || typeof linked !== "object" || !Object.hasOwn(linked, "worldPackage") || Object.keys(linked).length !== 1) throw new Error("content_snapshot_invalid");
    const linkedRecord = linked as Record<string, unknown>;
    if (linkedRecord.worldPackage !== null) {
      if (!linkedRecord.worldPackage || typeof linkedRecord.worldPackage !== "object" || Array.isArray(linkedRecord.worldPackage)) throw new Error("content_snapshot_invalid");
      const reference = linkedRecord.worldPackage as Record<string, unknown>;
      if (Object.keys(reference).length !== 3) throw new Error("content_snapshot_invalid");
      if (typeof reference.packageId !== "string" || typeof reference.version !== "string" || typeof reference.contentDigest !== "string") throw new Error("content_snapshot_invalid");
      const available = parseInstalledPackages(await creatorRequest<unknown>("creator.content.list", {})) ?? [];
      const item = available.find(candidate => candidate.packageId === reference.packageId && candidate.version === reference.version && candidate.contentDigest === reference.contentDigest);
      if (!item) throw new Error("content_package_not_found");
      const world = await inspectInstalledWorld(creatorRequest, item);
      if (!("defaultSeed" in world.manifest.entry)) throw new Error("content_city_binding_mismatch");
      if (!supportsInstalledWorldGenerator(world.manifest)) throw new Error("content_generator_incompatible");
      linkedWorld = world;
    }
    if (request !== cityOpenRequest.current) throw new Error("creator_city_view_superseded");
    draftCityViewRef.current = checked.value;
    draftViewStatusRef.current = "loading";
    draftViewFailureRef.current = undefined;
    draftEngineRef.current = null;
    draftDiagnosticsRef.current = { cityId: checked.value.cityId, revision: checked.value.revision, correlationId: `view:${crypto.randomUUID()}`, started: performance.now(), unavailable: false };
    await recordCityDiagnostic(checked.value, "view_started");
    if (request !== cityOpenRequest.current) throw new Error("creator_city_view_superseded");
    setInstalledWorldView(linkedWorld);
    setDraftCityView(checked.value);
    setMessage(`正在预览独立城市 ${checked.value.name}（版本 ${checked.value.revision}）${linkedWorld ? "及其固定世界包场景" : ""}；场景是否成功加载尚未确认。`);
    return { cityId: checked.value.cityId, revision: checked.value.revision, status: "loading", mode: "read_only_preview" };
  };
  useEffect(() => {
    const saved = studioTasks.saved;
    if (!saved) return;
    if (saved.artifact.kind === "creator-city") {
      const { cityId } = saved.artifact;
      if (cityId && draftCityViewRef.current?.cityId === cityId) {
        void openCityView(cityId, saved.revision).catch(cause => {
          setMessage(describeError(cause, "creator_city_view_failed"));
        });
      }
      void loadCities();
      return;
    }
    if (saved.artifact.kind !== "creator-project") return;
    const { projectId } = saved.artifact;
    if (!projectId || projectRef.current?.projectId !== projectId) return;
    let active = true;
    void creatorRequest<Project>("creator.project.read", { projectId }).then(latest => {
      const current = projectRef.current;
      if (active && current && current.projectId === projectId && latest.revision >= current.revision) {
        applyRef.current(latest, "preserve", current);
      }
    }).catch(cause => {
      if (active) setMessage(describeError(cause, "creator_refresh_failed"));
    });
    return () => { active = false; };
  }, [studioTasks.saved, creatorRequest]);
  const [colliderPreviews, setColliderPreviews] = useState<readonly AgentColliderPreview[]>([]);
  const rememberColliderPreview = (preview: AgentColliderPreview) => {
    setColliderPreviews(current => [...current.filter(item => item.previewId !== preview.previewId), preview].slice(-8));
  };
  const [expiredPreviewId, setExpiredPreviewId] = useState<string>();
  const task = studioTasks.task;
  const scenePreviewRequired = task ? taskHasSceneObjectPreview(task) : false;
  const taskPreview = task?.phase === "awaiting-review" && task.proposedChangeSetId && !hasDrafts(project) && task.evidence.some(evidence =>
    evidence.kind === "preview" && evidence.trustLevel === "host-observed" && evidence.planRevision === task.planRevision &&
    (evidence.data as { previewId?: unknown } | null)?.previewId === task.proposedChangeSetId)
    ? colliderPreviews.find(item => item.previewId === task.proposedChangeSetId && item.projectId === project?.projectId &&
        item.revision === project.revision && item.expiresAt > Date.now() && item.previewId !== expiredPreviewId) ?? null : null;
  const [lockedPreview, setLockedPreview] = useState<AgentColliderPreview | null>(null);
  const activePreview = lockedPreview ?? taskPreview;
  const previewLocked = lockedPreview !== null;
  useEffect(() => { setLockedPreview(null); }, [previewResetScope]);
  useEffect(() => {
    if (lockedPreview && taskPreview && lockedPreview.previewId !== taskPreview.previewId) setMessage("Agent 已生成新改动；Preview 当前已锁定，解锁并查看对应预览后才能保存。");
  }, [lockedPreview, taskPreview]);
  const togglePreviewLock = () => {
    if (lockedPreview) { setLockedPreview(null); setMessage("Preview 已解锁，画面将跟随当前任务。"); }
    else if (taskPreview) { setLockedPreview(taskPreview); setMessage("Preview 已锁定；其他 Session 的新任务不会自动替换当前画面。"); }
  };
  const agentScenePreview = useAgentScenePreview(creatorRequest, activePreview, project);
  useEffect(() => {
    if (!activePreview) return;
    const timeout = window.setTimeout(() => {
      setLockedPreview(current => current?.previewId === activePreview.previewId ? null : current);
      setExpiredPreviewId(activePreview.previewId);
    }, Math.max(0, activePreview.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [activePreview]);
  const colliderEngine = route.section === "workspace" && !draftCityView && !installedWorldView && project?.cityLayout &&
    baseViewport.status === "ready" && matchesPreviewBase(baseViewport.engine, project.cityLayout.seed, project.cityLayout.worldRevision)
    ? baseViewport.engine : null;
  const visibleColliderPreview = colliderEngine && activePreview && !activePreview.sceneOperations &&
    (activePreview.boxes.length || activePreview.removed.some(id => project?.scene?.objects.some(object => object.id === id && object.kind === "collider")))
    ? activePreview : null;
  useColliderViewport(colliderEngine, project?.scene, visibleColliderPreview);
  useCreatorHostBridge({
    projectRef, applyRef, studioEngineRef, isolatedProjectEngineRef, baseViewportStatusRef, draftCityViewRef, draftEngineRef, draftViewStatusRef, draftViewFailureRef, draftDiagnosticsRef,
    approvalGate, openCityView, recordCityDiagnostic, recordAgentActivity, restoreAgentActivity, rememberColliderPreview, setAgentCommit, setMessage, setActivePanel: openWorkspacePanel,
  });

  useEffect(() => {
    const changed = () => {
      void refresh().then(async () => {
        if (!project) return;
        const current = await creatorRequest<Project>("creator.project.read", { projectId: project.projectId });
        // Agent/其他来源的提交经此刷新：有草稿的区域保留本地输入（基于新
        // revision 重新校验后提交），无草稿区域同步服务端状态；revision 前进时提示冲突。
        const outcome = applyRef.current(current, "preserve", project);
        if (current.revision !== project.revision) {
          setMessage(outcome.preservedDrafts
            ? `项目已保存新版本（revision ${current.revision}，来自 Agent 或其他来源）。你的未提交草稿已保留在旧版本基础上；提交前请重新校验预览（差异按新版本计算），或手动放弃。`
            : `项目已保存新版本（revision ${current.revision}，来自 Agent 或其他来源）。`);
        }
      }).catch(error => setMessage(error instanceof Error ? error.message : "creator_refresh_failed"));
    };
    window.addEventListener("__CREATOR_PROJECT_CHANGED__", changed);
    const layoutsChanged = () => { void refresh().catch(error => setMessage(error instanceof Error ? error.message : "creator_refresh_failed")); };
    window.addEventListener("__CREATOR_LAYOUT_CHANGED__", layoutsChanged);
    return () => { window.removeEventListener("__CREATOR_PROJECT_CHANGED__", changed); window.removeEventListener("__CREATOR_LAYOUT_CHANGED__", layoutsChanged); };
  }, [project, refresh]);
  useEffect(() => {
    let cancelled = false;
    void loadStudioAtStartup(refresh, { isCancelled: () => cancelled, delay: ms => new Promise(resolve => window.setTimeout(resolve, ms)) })
      .catch(error => { if (!cancelled) setMessage(describeError(error, "creator_load_failed")); });
    return () => { cancelled = true; };
  }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    void loadStudioAtStartup(async () => {
      const context = await creatorRequest<{ runId: string; projectId: string; revision: number; status: "completed" | "cancelled" | "failed";
      evidence?: { tick: number; counters: Record<string, number>; outcome: "success" | "failure" | null } | null; failureCode?: string | null } | null>("creator.project.playtest.return_context", {});
      if (cancelled) return;
      const projectId = projectIdAfterStudioReload(context?.projectId, readStoredStudioProject(window.localStorage));
      if (!projectId) return;
      if (context) {
        const counters = context.evidence ? Object.entries(context.evidence.counters).map(([key, value]) => `${key}=${value}`).join(", ") : "";
        const result = context.evidence ? ` · tick ${context.evidence.tick} · ${context.evidence.outcome ?? "未完成"}${counters ? ` · ${counters}` : ""}` : context.failureCode ? ` · ${context.failureCode}` : "";
        const message = `City 试玩已返回：${context.status} · revision ${context.revision}${result} · ${context.runId}`;
        // PRD：试玩结束回到同一编辑上下文——保留未提交草稿，并回到全局视角。
        openWorkspacePanel("agent");
        void openProject(projectId, "preserve").then(() => { setFocusSignal(value => value + 1); setMessage(message); });
      } else {
        // Retry rebuilt the WebView after the one-shot return was already consumed.
        // Reopen the last project only. Do not start another playtest.
        void openProject(projectId, "replace");
      }
    }, { isCancelled: () => cancelled, delay: ms => new Promise(resolve => window.setTimeout(resolve, ms)) }).catch(error => {
        const code = errorCode(error, "creator_playtest_return_failed");
        if (!cancelled && code !== "creator_playtest_not_found") setMessage(code);
      });
    return () => { cancelled = true; };
  }, []);

  const openProject = async (projectId: string, mode: "replace" | "preserve" = "replace") => {
    setInstalledWorldView(null);
    setBusy(true); setMessage(""); setPreviewId(null); setPreviewKind(null);
    try {
      const next = await creatorRequest<Project>("creator.project.read", { projectId });
      rememberStudioProject(window.localStorage, next.projectId);
      applyProject(next, mode, project);
      cityOpenRequest.current++; draftCityViewRef.current = null; setDraftCityView(null);
      setFocusSignal(value => value + 1);
      return true;
    } catch (error) {
      const code = errorCode(error, "creator_read_failed");
      if (code === "creator_project_not_found" || code === "not_found") forgetStudioProject(window.localStorage);
      setMessage(error instanceof Error ? error.message : "creator_read_failed");
      return false;
    }
    finally { setBusy(false); }
  };
  const createProject = async (destination: StudioPanel = "agent") => {
    setBusy(true); setMessage("");
    // 创建同样幂等：结果确定前保留同一 operationId，响应失败后重试命中服务端
    // 记录而不是重复建项目。
    const operationId = pendingCreateId ?? `create:${crypto.randomUUID()}`;
    setPendingCreateId(operationId);
    const discardedDrafts = hasDrafts(project);
    try {
      if (!worldRevision) throw new Error("creator_layout_not_bound");
      const selectedLayout = layouts.find(layout => layoutSelectionKey(layout) === worldRevision);
      if (!selectedLayout) throw new Error("creator_layout_not_bound");
      const created = await creatorRequest<{ projectId: string }>("creator.project.create", {
        template, worldRevision: selectedLayout.worldRevision, operationId,
        ...(selectedLayout.cityId ? { cityId: selectedLayout.cityId } : {}),
      });
      await refresh().catch(() => {});
      if (!await openProject(created.projectId)) return;
      if (destination === "agent") updateProjectGoal(created.projectId, goalDraft);
      setPendingCreateId(null);
      setCatalogStartMode(null);
      openWorkspacePanel(destination);
      if (discardedDrafts) setMessage("已创建新项目；之前项目的未提交草稿已丢弃。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_create_failed"); }
    finally { setBusy(false); }
  };
  const preview = async () => {
    if (!project) return;
    setBusy(true); setMessage("");
    try {
      const game: unknown = JSON.parse(text);
      const validation = await buildGameValidation(project.projectId, project.revision, game);
      const result = await creatorRequest<{ previewId: string; diff: unknown }>("creator.game.preview", { projectId: project.projectId, baseRevision: project.revision, game, validation });
      setPreviewId(result.previewId); setPreviewKind("game");
      setMessage(validation.ok ? "规则预览通过。确认提交后生成新 revision。"
        : "SDK 语义校验发现问题：预览仍已生成，但提交会被拒绝。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_preview_failed"); }
    finally { setBusy(false); }
  };
  const previewScene = async () => {
    if (!project) return;
    setBusy(true); setMessage("");
    try {
      const next: unknown = JSON.parse(sceneText);
      if (!next || typeof next !== "object" || (next as SceneDraft).schemaVersion !== 1 || !Array.isArray((next as SceneDraft).objects)) throw new Error("scene_invalid_shape");
      const previousObjects = project.scene?.objects ?? [];
      const nextObjects = (next as SceneDraft).objects;
      const previousById = new Map(previousObjects.map(object => [object.id, object]));
      const nextById = new Map(nextObjects.map(object => [object.id, object]));
      const operations: Array<Record<string, unknown>> = [];
      for (const object of previousObjects) if (!nextById.has(object.id)) operations.push({ op: object.kind === "anchor" ? "anchor.remove" : "scene.object.remove", objectId: object.id });
      for (const object of nextObjects) {
        const previous = previousById.get(object.id);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(object)) operations.push({ op: object.kind === "anchor" ? "anchor.upsert" : "scene.object.upsert", object });
      }
      if (operations.length === 0) throw new Error("scene_no_changes");
      const validation = await buildSceneValidation(project, project.projectId, project.revision, operations);
      const result = await creatorRequest<{ previewId: string }>("creator.scene.preview", { projectId: project.projectId, baseRevision: project.revision, operations, validation });
      setPreviewId(result.previewId); setPreviewKind("scene");
      setMessage(validation.ok ? `场景预览通过（${operations.length} 项变更）。确认提交后生成新 revision。`
        : `SDK 语义校验发现问题（${operations.length} 项变更）：预览仍已生成，但提交会被拒绝。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_scene_preview_failed"); }
    finally { setBusy(false); }
  };
  const inspectWorldPackage = async () => {
    setBusy(true); setMessage("");
    try {
      const inspection = parseWorldPackageInspection(await creatorRequest<unknown>("creator.content.inspect", {}));
      if (!inspection) throw new Error("content_inspection_invalid");
      setPackageInspection(inspection);
      setMessage("世界内容包完整性预检通过：可安装到本机内容库；语义、运行时兼容、来源未检查，安装后仍不可运行。");
    } catch (error) { setPackageInspection(null); setMessage(`世界内容包预检失败（${errorCode(error, "content_inspection_failed")}）。`); }
    finally { setBusy(false); }
  };
  const refreshInstalled = async () => {
    if (browserPreview) return;
    try {
      const parsed = parseInstalledPackages(await creatorRequest<unknown>("creator.content.list", {}));
      if (parsed) setInstalledPackages(parsed);
    } catch { /* 内容库列表是可选状态，不阻塞创作 */ }
  };
  useEffect(() => { void refreshInstalled(); }, []);
  // 插件实例可能比首帧更晚 ready；切到项目面板时再拉一次已安装列表。
  useEffect(() => { if (activePanel === "project") void refreshInstalled(); }, [activePanel]);
  const installInspectedPackage = async () => {
    if (!packageInspection) return;
    setBusy(true); setMessage("");
    try {
      const result = parseInstallResult(await creatorRequest<unknown>("creator.content.install", { inspectionId: packageInspection.inspectionId }));
      if (!result) throw new Error("content_install_invalid");
      setPackageInspection(null);
      await refreshInstalled();
      setMessage(result.alreadyInstalled ? `${result.packageId}@${result.version} 已在本机内容库中。`
        : `已安装 ${result.packageId}@${result.version} 到本机内容库（仅存储，尚不可运行）。`);
    } catch (error) {
      const code = errorCode(error, "content_install_failed");
      setPackageInspection(null);
      setMessage(code === "content_store_corrupt"
        ? "本机已有的内容包已损坏，无法确认安装。请先卸载该版本，再重新选择内容包进行预检和安装。"
        : `内容包安装失败（${code}）。请重新选择内容包进行预检。`);
    }
    finally { setBusy(false); }
  };
  const uninstallInstalledPackage = async (item: InstalledContentPackage) => {
    setBusy(true); setMessage(""); setConfirmUninstall(null);
    try {
      await creatorRequest("creator.content.uninstall", { packageId: item.packageId, version: item.version });
      if (installedWorldView?.manifest.packageId === item.packageId && installedWorldView.manifest.version === item.version) setInstalledWorldView(null);
      await refreshInstalled();
      setMessage(`已卸载 ${item.packageId}@${item.version}。`);
    } catch (error) {
      const code = errorCode(error, "content_uninstall_failed");
      setMessage(code === "content_package_in_use" ? "该世界包仍被城市引用，无法卸载。" : `内容包卸载失败（${code}）。`);
    }
    finally { setBusy(false); }
  };
  const validateInstalledPackage = async (item: InstalledContentPackage) => {
    setBusy(true); setMessage("");
    try {
      const world = await inspectInstalledWorld(creatorRequest, item);
      setMessage(supportsInstalledWorldGenerator(world.manifest)
        ? `${item.packageId}@${item.version} 内容和 SDK 语义检查通过，生成器版本匹配；其余运行时兼容性、来源与可运行性尚未验证。`
        : `${item.packageId}@${item.version} 内容和 SDK 语义检查通过，但生成器版本与当前 City 不兼容。`);
    } catch (error) { setMessage(`内容包检查失败（${errorCode(error, "content_validation_failed")}）。`); }
    finally { setBusy(false); }
  };
  const previewInstalledPackage = async (item: InstalledContentPackage) => {
    setBusy(true); setMessage("");
    try {
      const world = await inspectInstalledWorld(creatorRequest, item);
      if (!supportsInstalledWorldGenerator(world.manifest)) throw new Error("content_generator_incompatible");
      cityOpenRequest.current++; draftCityViewRef.current = null; setDraftCityView(null);
      setInstalledWorldView(world);
      setMessage("世界包只读预览正在加载；场景碰撞和玩法尚未启用。");
    } catch (error) { setMessage(`无法预览世界包（${errorCode(error, "content_preview_failed")}）。`); }
    finally { setBusy(false); }
  };
  const createCityFromInstalledWorld = async (item: InstalledContentPackage) => {
    const cityName = item.packageId;
    setBusy(true); setMessage("");
    try {
      const world = await inspectInstalledWorld(creatorRequest, item);
      if (!supportsInstalledWorldGenerator(world.manifest)) throw new Error("content_generator_incompatible");
      if (!("defaultSeed" in world.manifest.entry)) throw new Error("content_snapshot_invalid");
      const operationId = `world:${crypto.randomUUID()}`;
      const request = { name: cityName, operationId, packageId: item.packageId, version: item.version,
        seed: world.manifest.entry.defaultSeed, profile: world.profile };
      const validation = validateCityInstance({ schemaVersion: 1, cityId: "city-validation", revision: 0,
        name: request.name, seed: request.seed, profile: request.profile });
      const result = await creatorRequest<{ cityId: string; revision: number }>("creator.city.create_from_world", {
        name: request.name, operationId, packageId: item.packageId, version: item.version,
        validation: { schemaVersion: 1, requestDigest: await digest({ name: request.name, operationId, packageId: item.packageId, version: item.version, contentDigest: item.contentDigest }), ok: validation.ok },
      });
      await loadCities();
      setMessage(`已创建并保存独立城市「${cityName}」（版本 ${result.revision}），来源 ${item.packageId}@${item.version}。城市名称可随后编辑。正在加载只读预览。`);
      try { await openCityView(result.cityId, result.revision); }
      catch (error) { setMessage(`城市已保存，但预览加载失败（${errorCode(error, "creator_city_view_failed")}）。`); }
    } catch (error) { setMessage(`无法从世界包创建城市（${errorCode(error, "creator_city_create_failed")}）。`); }
    finally { setBusy(false); }
  };
  const importModel = async () => {
    if (!project) return;
    setBusy(true); setMessage("");
    try {
      const imported = await creatorRequest<{ revision: number; assetId: string; assetRef: Record<string, unknown>; byteLength: number; boundsMeters: { x: number; y: number; z: number } }>(
        "creator.asset.import", { projectId: project.projectId, expectedRevision: project.revision, operationId: `asset:${crypto.randomUUID()}` });
      const updated = await creatorRequest<Project>("creator.project.read", { projectId: project.projectId });
      const model = { id: `model-${crypto.randomUUID()}`, kind: "model", asset: imported.assetRef, transform: {
        positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      } };
      // 资产导入也是一次 revision 提交：其他区域草稿（如规则 JSON）保留，场景草稿继续在当前输入上追加模型。
      applyProject(updated, "preserve", project);
      const scene: SceneDraft = JSON.parse(sceneText);
      setSceneText(JSON.stringify({ ...scene, objects: [...scene.objects, model] }, null, 2));
      setPublishedReleaseId(null); await refresh();
      setMessage(`模型已导入并加入场景草稿（${imported.assetId} · ${Math.ceil(imported.byteLength / 1024)} KiB）。请校验并提交场景 revision。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_asset_import_failed"); }
    finally { setBusy(false); }
  };
  const previewMount = async () => {
    if (!project) return;
    setBusy(true); setMessage("");
    try {
      const gameDraft: unknown = JSON.parse(text);
      if (canonicalJson(gameDraft) !== canonicalJson(project.game)) throw new Error("请先校验并保存玩法规则，再配置场地。");
      const gameResult = validateMiniGamePack(gameDraft);
      if (!gameResult.ok) throw new Error(gameResult.diagnostics[0]?.code ?? "creator_game_invalid");
      const layoutSnapshot = validateCityLayoutSnapshot(project.cityLayout);
      if (!layoutSnapshot.ok) throw new Error(layoutSnapshot.diagnostics[0]?.code ?? "creator_layout_not_bound");
      const layout = layoutSnapshot.value.layout;
      const bindings = JSON.parse(bindingsText) as Record<string, string[]>;
      if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw new Error("creator_mount_binding_invalid");
      const mount: CityGameMountV1 = {
        schemaVersion: 1, mountId: project.mounts[0]?.mountId ?? "main-mount",
        layout: { kind: "city-layout", id: layout.id, version: "1", digest: layoutSnapshot.value.worldRevision },
        game: { kind: "city-minigame", id: gameResult.value.id, version: "1", digest: await digest(project.game) },
        entryAnchorId, bindings,
        // 完成阈值参数必须与绑定数一致（检查点绑 5 门 → gateTarget=5）；留在 pack 默认值
        // 会让第 4/5 门永远无效，且 validateMount 会以 parameter_binding_mismatch 拒绝。
        parameterOverrides: completionThresholdOverrides(gameResult.value, bindings),
      };
      const mountResult = validateMount({ layout, game: gameResult.value, mount,
        resolvedRefs: { layout: { kind: "city-layout", id: layout.id, version: "1", digest: layoutSnapshot.value.worldRevision }, game: mount.game } });
      if (!mountResult.ok) {
        const diagnostic = mountResult.diagnostics[0];
        if (diagnostic?.code === "slot_binding_count") {
          const slot = diagnostic.path.split(".").pop() ?? "";
          const spec = gameResult.value.slots[slot];
          const count = Array.isArray(bindings[slot]) ? bindings[slot].length : 0;
          if (spec) throw new Error(`“${mountSlotLabel(slot)}”需要 ${spec.min} 至 ${spec.max} 个，当前已选 ${count} 个。`);
        }
        throw new Error(diagnostic?.message ?? "场地校验失败，请检查入口和目标。");
      }
      const result = await creatorRequest<{ previewId: string }>("creator.scene.preview", {
        projectId: project.projectId, baseRevision: project.revision, operations: [{ op: "mount.bind", mount }],
        validation: await buildSceneValidation(project, project.projectId, project.revision, [{ op: "mount.bind", mount }]),
      });
      setPreviewId(result.previewId); setPreviewKind("mount");
      setMessage("挂载校验通过。提交后保存到项目；发布后可在绑定的 City 中试玩。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_mount_preview_failed"); }
    finally { setBusy(false); }
  };
  const previewSkin = async (skinId: string) => {
    if (!project) return;
    setBusy(true); setMessage("");
    try {
      const result = await creatorRequest<{ previewId: string }>("creator.scene.preview", {
        projectId: project.projectId, baseRevision: project.revision, operations: [{ op: "skin.select", skinId }],
        validation: await buildSceneValidation(project, project.projectId, project.revision, [{ op: "skin.select", skinId }]),
      });
      setPreviewId(result.previewId); setPreviewKind("skin");
      setMessage("皮肤选择可提交。当前只保存官方皮肤 ID，不会改变已打开 City 的外观。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_skin_preview_failed"); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!project || !previewId || !previewKind) return;
    setBusy(true); setMessage("");
    // 同一次操作在结果确定前保留同一 operationId：服务端已提交而响应丢失时，
    // 重试命中幂等记录而不是产生第二次提交，操作状态查询也用它。
    const operationId = pendingEdit?.projectId === project.projectId ? pendingEdit.operationId : `edit:${crypto.randomUUID()}`;
    setPendingEdit({ projectId: project.projectId, operationId });
    const finish = async (note: string) => {
      setPendingEdit(null); setPreviewId(null); setPublishedReleaseId(null);
      const current = await creatorRequest<Project>("creator.project.read", { projectId: project.projectId });
      // 保留其他区域的未提交草稿：刚提交的区域草稿与新保存值一致，自然被同步。
      applyProject(current, "preserve", project);
      await refresh();
      setMessage(note);
    };
    try {
      await creatorRequest(previewKind === "game" ? "creator.game.commit" : "creator.scene.commit", { projectId: project.projectId, previewId, expectedRevision: project.revision, operationId });
      await finish("已保存新版本。");
    } catch (error) {
      const code = errorCode(error, "creator_commit_failed");
      // 响应失败不等于操作失败：用保留的 operationId 查询服务端结果再下结论。
      try {
        const status = await creatorRequest<{ status: string }>("creator.operation.status", { projectId: project.projectId, operationId });
        if (status.status === "committed") await finish("上一次提交已生效（此前响应丢失）；已恢复最新版本。");
        else setMessage(`${code} · 提交未完成（服务端无此操作记录）；本次操作标识已保留，可直接重试。`);
      } catch {
        setMessage(`${code} · 无法确认提交结果；本次操作标识已保留，可直接重试。`);
      }
    }
    finally { setBusy(false); }
  };
  const publish = async () => {
    if (!project) return;
    setBusy(true); setMessage("");
    try {
      const release = await creatorRequest<ReleaseRef & { revision: number }>("creator.project.publish", {
        projectId: project.projectId, expectedRevision: project.revision,
      });
      setPublishedReleaseId(release.releaseId);
      setMessage(`已发布到我的 City：revision ${release.revision}（${release.releaseId}）。此版本固定，不会随草稿修改。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_publish_failed"); }
    finally { setBusy(false); }
  };
  const createCandidate = async () => {
    if (!project || browserPreview || hasUncommittedProjectEdits || !project.mounts.length) return;
    setBusy(true); setMessage("");
    try {
      const created = parseProjectCandidate(await creatorRequest<unknown>("creator.project.candidate.create", {
        projectId: project.projectId, expectedRevision: project.revision,
      }));
      if (!created) throw new Error("creator_candidate_invalid");
      setCandidate(created);
      setMessage(`已创建不可变 Candidate（revision ${project.revision}）；它不是 Release。构建与校验已完成，但真实可玩性仍需 City 试玩证据。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_candidate_create_failed"); }
    finally { setBusy(false); }
  };
  const startCandidatePlaytest = async () => {
    if (!project || !candidate || hasUncommittedProjectEdits || candidate.status === "testing" || candidate.status === "accepted" || candidate.status === "unknown") return;
    setBusy(true); setMessage("");
    try {
      const started = await creatorRequest<{ runId: string }>("creator.project.playtest.start", {
        candidateId: candidate.candidateId, projectId: project.projectId, expectedRevision: project.revision,
      });
      setCandidate(current => current?.candidateId === candidate.candidateId ? { ...current, status: "testing" } : current);
      syncCandidateRef.current(project.projectId, project.revision);
      setMessage(`正在切换到 Candidate 真实 City 试玩（${started.runId}）。证据将标记为 City 客户端回报，不是 Host 验证。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_candidate_playtest_failed"); }
    finally { setBusy(false); }
  };
  const acceptCandidate = async () => {
    if (!project || hasUncommittedProjectEdits || !canAcceptCandidate(candidate)) return;
    setBusy(true); setMessage("");
    try {
      const release = await creatorRequest<ReleaseRef & { revision: number }>("creator.project.candidate.accept", { candidateId: candidate.candidateId });
      setPublishedReleaseId(release.releaseId);
      syncCandidateRef.current(project.projectId, project.revision);
      setMessage(`已人工接受 Candidate 并创建正式 Release（${release.releaseId}）。测试证据来源为 City 客户端回报，不是 Host 验证。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_candidate_accept_failed"); }
    finally { setBusy(false); }
  };
  const startPlaytest = async () => {
    if (!project || !publishedReleaseId) return;
    setBusy(true); setMessage("");
    try {
      const started = await creatorRequest<{ runId: string }>("creator.project.playtest.start", { releaseId: publishedReleaseId });
      setMessage(`正在切换到 City 试玩（${started.runId}）。退出玩法后会返回这个项目。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_playtest_start_failed"); }
    finally { setBusy(false); }
  };
  const hasUncommittedProjectEdits = hasDrafts(project);
  const loadedProjectScene = useProjectSceneAssets(creatorRequest, project);
  const projectSceneView = useMemo(() => {
    const loaded = loadedProjectScene.state;
    if (!project || loadedProjectScene.key !== `${project.projectId}:${project.revision}` || loaded?.key !== loadedProjectScene.key
      || loaded.status !== "ready" || !loaded.scene || !loaded.assets || !loaded.files) return null;
    return composeProjectSceneView(projectCity?.worldScene, { scene: loaded.scene, assets: loaded.assets, files: loaded.files });
  }, [project, projectCity?.worldScene, loadedProjectScene.key, loadedProjectScene.state]);

  // A second, read-only renderer keeps the original edit session and its pending saves alive.
  // Task scene previews replay the complete saved scene; city patches still require one complete patch.
  const agentCityPreview = useMemo(() => {
    if (!project || hasUncommittedProjectEdits || draftCityView || viewportSeed === null || !project.cityLayout?.worldRevision
      || baseViewport.status !== "ready" || baseViewport.engine !== studioEngineRef.current
      || !matchesPreviewBase(baseViewport.engine, viewportSeed, project.cityLayout.worldRevision)) return null;
    if (activePreview?.sceneOperations) {
      const plan = agentScenePreview.plan;
      const loaded = agentScenePreview.state;
      if (activePreview.projectId !== project.projectId || activePreview.revision !== project.revision || !plan
        || loaded?.context !== plan || loaded.status !== "ready" || !loaded.assets || !loaded.files) return null;
      if (projectCityKey && !projectCity?.city) return null;
      const worldScene = composeProjectSceneView(projectCity?.worldScene, { scene: plan.scene, assets: loaded.assets, files: loaded.files });
      if (!worldScene) return null;
      return { patch: null, worldScene, worldScenePreview: true, seed: viewportSeed, worldRevision: project.cityLayout.worldRevision,
        baseEngine: baseViewport.engine, isolated: !!projectCityKey, profile: projectCityKey ? projectCity!.city!.profile : worldProfile };
    }
    const raw = agentCommit?.proposal.cityPatch;
    if (!agentCommit?.proposal.requiresCityPreview || !raw || typeof raw !== "object" || Array.isArray(raw)
      || project.projectId !== agentCommit.projectId || project.revision !== agentCommit.expectedRevision
      || (raw as { seed?: unknown }).seed !== viewportSeed) return null;
    if (projectCityKey && (!projectCity?.city || projectCity.key !== projectCityKey || !validateWorldPlanPatch(raw, viewportSeed, CITY_GENERATOR_VERSION).ok)) return null;
    return { patch: raw as PlanPatchV1, seed: viewportSeed, worldRevision: project.cityLayout.worldRevision, baseEngine: baseViewport.engine, isolated: !!projectCityKey,
      profile: projectCityKey ? projectCity!.city!.profile : worldProfile };
  }, [activePreview, agentScenePreview.plan, agentScenePreview.state, agentCommit, project, hasUncommittedProjectEdits, draftCityView, viewportSeed, projectCityKey, projectCity, worldProfile, baseViewport]);
  // R2 诊断：sceneOperations 预览未就绪时，给出具体卡住的门控（与上方 memo 同条件）。
  const scenePreviewGateReason = useMemo<string | null>(() => {
    if (!activePreview?.sceneOperations) return null;
    if (!project) return "未打开项目";
    if (hasUncommittedProjectEdits) return "存在未提交草稿";
    if (draftCityView) return "City 只读预览占用视口";
    if (viewportSeed === null) return "基线视口尚未生成";
    if (baseViewport.status !== "ready") return "基线视口尚未就绪";
    if (baseViewport.engine !== studioEngineRef.current) return "基线引擎不匹配";
    if (!project.cityLayout?.worldRevision) return "项目未绑定 City 布局";
    if (!matchesPreviewBase(baseViewport.engine, viewportSeed, project.cityLayout.worldRevision)) return "基线种子与布局不一致";
    if (activePreview.projectId !== project.projectId) return "预览属于其他项目";
    if (activePreview.revision !== project.revision) return `预览基线 ${activePreview.revision} ≠ 当前 ${project.revision}`;
    const plan = agentScenePreview.plan;
    const loaded = agentScenePreview.state;
    if (!plan) return "提案无法构成有效场景草稿";
    if (loaded?.context !== plan) return "资产加载上下文过期";
    if (loaded.status === "loading") return "正在加载项目资产";
    if (loaded.status === "failed") return `项目资产加载失败（${loaded.code ?? "未知"}）`;
    if (!loaded.assets || !loaded.files) return "资产快照不完整";
    if (projectCityKey && !projectCity?.city) return "项目 City 实例尚未加载";
    return null;
  }, [activePreview, agentScenePreview.plan, agentScenePreview.state, project, hasUncommittedProjectEdits, draftCityView, viewportSeed, projectCityKey, projectCity, baseViewport]);
  const agentViewportPreviewId = activePreview?.sceneOperations ? activePreview.previewId : agentCommit?.previewId;
  // 预览就绪后自动把镜头带到第一个改动对象；同一 Preview 只定位一次（手动“查看改动”仍可重定位）。
  const autoFocusPreviewRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activePreview?.sceneOperations || !agentCityPreview || agentPreviewStatus?.context !== agentCityPreview
      || agentPreviewStatus.status !== "ready" || !agentPreviewEngineRef.current) return;
    if (autoFocusPreviewRef.current === activePreview.previewId) return;
    autoFocusPreviewRef.current = activePreview.previewId;
    const evidence = studioTasks.task?.evidence.find(item => item.kind === "preview" && item.trustLevel === "host-observed"
      && (item.data as { previewId?: unknown } | null)?.previewId === activePreview.previewId);
    const changed = (evidence?.data as { changedObjects?: unknown } | null)?.changedObjects;
    const entityId = Array.isArray(changed) ? changed.find(item => typeof (item as { id?: unknown })?.id === "string") : null;
    if (entityId) agentPreviewEngineRef.current.focusEntity(String((entityId as { id: string }).id));
  }, [activePreview, agentCityPreview, agentPreviewStatus, studioTasks.task]);

  const resolveAgentCommit = async (approve: boolean) => {    const pending = agentCommit;
    if (!pending || busy) return;
    if (!approve) { approvalGate.current.clear(pending); setAgentCommit(null); setMessage("已取消待处理的 Agent 请求；如此前提交结果未确认，请查询操作状态。"); return; }
    if (!project || project.projectId !== pending.projectId || project.revision !== pending.expectedRevision || hasUncommittedProjectEdits) {
      setMessage("请打开对应项目和版本，并处理未提交草稿后再确认。"); return;
    }
    if (pending.proposal.requiresCityPreview && (!agentCityPreview || agentPreviewStatus?.context !== agentCityPreview || agentPreviewStatus.status !== "ready"
      || agentCityPreview.baseEngine !== studioEngineRef.current || !matchesPreviewBase(agentCityPreview.baseEngine, agentCityPreview.seed, agentCityPreview.worldRevision))) {
      setMessage("城市修改的三维预览尚未就绪或包含失效项，请重新预览后再确认。"); return;
    }
    if (pending.proposal.expiresAt <= Date.now()) { approvalGate.current.clear(pending); setAgentCommit(null); setMessage("预览已过期，请让 Agent 重新预览。"); return; }
    setBusy(true); setMessage("");
    try {
      try {
        await creatorRequest(pending.method, { projectId: pending.projectId, previewId: pending.previewId, expectedRevision: pending.expectedRevision, operationId: pending.operationId });
      } catch (error) {
        const status = await creatorRequest<{ status: string }>("creator.operation.status", { projectId: pending.projectId, operationId: pending.operationId });
        if (status.status !== "committed") throw error;
      }
      approvalGate.current.clear(pending); setAgentCommit(null);
      const latest = await creatorRequest<Project>("creator.project.read", { projectId: pending.projectId });
      applyProject(latest, "preserve", project); await refresh();
      setMessage(`Agent 修改已确认并保存（版本 ${latest.revision}）。`);
    } catch (error) {
      const code = errorCode(error, "creator_commit_failed");
      if (code === "revision_conflict" || code === "preview_expired" || code === "creator_preview_not_found") { approvalGate.current.clear(pending); setAgentCommit(null); }
      setMessage(`无法确认 Agent 提交结果（${code}）；请检查项目版本，必要时使用相同操作标识重试。`);
    } finally { setBusy(false); }
  };

  const exportCitySource = async () => {
    const city = draftCityView;
    if (browserPreview) { setMessage(exportBlockMessage("creator_export_browser_preview")); return; }
    if (busy) { setMessage(exportBlockMessage("creator_export_busy")); return; }
    if (!city) { setMessage("先打开要导出的城市。"); return; }
    setBusy(true);
    setMessage("正在打开目录选择…");
    try {
      const source = buildCitySourceExport(city, CITY_GENERATOR_VERSION);
      const assetDigests = installedWorldView?.assets.entries.map(entry => entry.sha256) ?? [];
      const result = await creatorRequest<{ directoryName: string; cityRevision: number; assetCount: number }>("creator.city.source.export", {
        cityId: city.cityId, revision: city.revision, ...source, assetDigests,
      });
      if (!/^city-source-[a-f0-9]+$/.test(result.directoryName) || result.cityRevision !== city.revision || result.assetCount !== assetDigests.length) throw new Error("creator_export_invalid");
      setMessage(`城市源码已导出至所选目录中的 ${result.directoryName}；这是未签名的源码项目。`);
    } catch (error) {
      const code = errorCode(error, "creator_export_failed");
      setMessage(code === "creator_export_cancelled" ? "没有选择目录，未写出源码。" : `城市源码导出失败（${code}）。请检查城市版本和编辑内容。`);
    } finally { setBusy(false); }
  };

  const exportSource = async () => {
    const block = exportClickBlock({
      browserPreview, busy, hasProject: project !== null,
      cityReady: project !== null && !!projectCity?.city && projectCity.key === projectCityKey,
      unsaved: hasUncommittedProjectEdits, mountCount: project?.mounts.length ?? 0,
    });
    if (block) { setMessage(exportBlockMessage(block)); return; }
    if (!project || !projectCity?.city) return;
    setBusy(true);
    setMessage("正在打开目录选择…");
    try {
      const source = await buildProjectSourceExport(project, projectCity.city, CITY_GENERATOR_VERSION);
      const result = await creatorRequest<{ directoryName: string; assetCount: number }>("creator.source.export", {
        projectId: project.projectId, revision: project.revision, ...source,
      });
      if (!/^city-source-[a-f0-9]+$/.test(result.directoryName) || !Number.isSafeInteger(result.assetCount)) throw new Error("creator_export_invalid");
      setMessage(`源码已导出至所选目录中的 ${result.directoryName}；${project.mounts.length ? "游戏布局为当前城市快照，换城市须重新绑定。" : "游戏尚未绑定场地，配置挂载后才能验证和试玩。"}`);
    } catch (error) {
      const code = errorCode(error, "creator_export_failed");
      setMessage(code === "creator_export_cancelled" ? "没有选择目录，未写出源码。" : `源码导出失败（${code}）。请检查项目版本、城市绑定及资产。`);
    } finally { setBusy(false); }
  };

  /** 体验包：把**已发布**版本打成自包含产物，再由用户选目录拷出。
   *  与源码导出的区别是「可交付」：包里带冻结发布快照 + v3 布局几何 + 资产字节，
   *  干净客户端不依赖 Creator 库即可安装并启动。 */
  const exportExperience = async () => {
    if (!project) { setMessage("先打开或创建项目"); return; }
    if (!publishedReleaseId) { setMessage("发布后即可打包体验；产物只来自已发布版本。"); return; }
    if (busy) return;
    setBusy(true);
    setMessage("正在打包体验包…");
    try {
      const built = await creatorRequest<{ experienceId: string; version: string; contentDigest: string; fileCount: number; byteLength: number }>(
        "creator.experience.build", { releaseId: publishedReleaseId, version: "1.0.0" });
      if (!/^experience-[a-f0-9]{16}$/.test(built.experienceId)) throw new Error("creator_experience_invalid");
      setMessage("正在打开目录选择…");
      const exported = await creatorRequest<{ exported: boolean; fileCount: number }>("creator.experience.export",
        { experienceId: built.experienceId, version: built.version });
      if (!exported.exported) throw new Error("creator_export_invalid");
      setMessage(`体验包已导出（${built.experienceId}@${built.version}，${built.fileCount} 个文件，${Math.max(1, Math.round(built.byteLength / 1024))} KiB）。`);
    } catch (error) {
      const code = errorCode(error, "creator_experience_export_failed");
      setMessage(code === "creator_export_cancelled" ? "没有选择目录，未写出体验包。"
        : code === "experience_export_target_exists" ? "目标目录里已有同名体验包；换一个目录或先删除旧包。"
        : code === "experience_layout_incomplete" ? "这份发布没有可交付的布局几何（v3），无法打包。"
        : `体验包导出失败（${code}）。`);
    } finally { setBusy(false); }
  };

  const readOnlyScene = !!(draftCityView || installedWorldView);
  const editingGame = !!project && !readOnlyScene;
  const toggleWorkspaceContent = () => {
    if (contentOpen) { setContentOpen(false); return; }
    if (activePanel === "agent") openWorkspacePanel(editingGame ? "play" : "project");
    else setContentOpen(true);
  };
  const nextStep = workspaceNextStep({ readOnly: readOnlyScene, hasProject: editingGame, hasLayout: !!project?.cityLayout,
    dirty: hasUncommittedProjectEdits, hasMounts: !!project?.mounts.length, browserPreview,
    candidate, candidateRead, published: !!publishedReleaseId });
  const handleWorkspaceAction = (action: Exclude<WorkspaceAction, "details">) => {
    switch (action) {
      case "mount": setEditorFocus("mount"); openWorkspacePanel("play"); return;
      case "draft": {
        if (!project) return;
        const pending = dirtyRegions(project);
        setEditorFocus(pending.game ? "game" : pending.scene ? "scene" : pending.mount ? "mount" : "skin");
        openWorkspacePanel("play");
        return;
      }
      case "settings": openWorkspacePanel("project"); return;
      case "create": void createCandidate(); return;
      case "test": void startCandidatePlaytest(); return;
      case "release": void startPlaytest(); return;
      case "refresh":
        if (project) {
          setCandidateRead("loading");
          syncCandidateRef.current(project.projectId, project.revision);
          syncPublicationRef.current(project.projectId, project.revision);
        }
    }
  };

  const [releaseRequest, setReleaseRequest] = useState(0);
  const toolbarActionRef = useRef<(commandId: string, value?: string) => void>(() => {});
  toolbarActionRef.current = (commandId, value) => {
    if (busy) return;
    if (storyHasDraft && (commandId === "creator.project.back" || commandId === "creator.navigate")) {
      setMessage("Story 有未保存的草稿。请切回 Story 工具并保存后再离开工作区。");
      return;
    }
    if (commandId === "creator.project.back") setRoute(STUDIO_PROJECTS_ROUTE);
    else if (commandId === "creator.navigate") {
      const destination = STUDIO_NAVIGATION.find(item => item.route.section === value)?.route;
      if (destination) setRoute(destination);
    } else if (commandId === "creator.project.search" && route.section === "projects") {
      setCatalogSearch(value?.trim() ?? "");
    } else if (commandId === "creator.project.new" && route.section === "projects") {
      setCatalogStartMode("new");
    } else if (route.section === "workspace" && commandId === "creator.workspace.content") {
      toggleWorkspaceContent();
    } else if (route.section === "workspace" && editingGame && activePanel !== "story" && commandId === "creator.workspace.release") {
      setContentOpen(false); setReleaseRequest(previous => previous + 1);
    }
  };
  useEffect(() => connect(command => toolbarActionRef.current(command.commandId, command.value)), []);
  useEffect(() => {
    publishToolbar([
      ...(route.section === "projects" ? [
        { id: "search", commandId: "creator.project.search", label: "搜索名称", kind: "search" as const, enabled: !busy, value: catalogSearch },
        { id: "new-project", commandId: "creator.project.new", label: "新建 Game 项目", kind: "button" as const, enabled: !busy },
      ] : [{ id: "back-to-projects", commandId: "creator.project.back", label: "返回项目库", kind: "button" as const, enabled: !busy }]),
      ...(route.section === "workspace" ? [
        { id: "content", commandId: "creator.workspace.content", label: "内容", kind: "button" as const, enabled: !busy },
        ...(editingGame && activePanel !== "story" ? [{ id: "release", commandId: "creator.workspace.release", label: "发布", kind: "button" as const, enabled: !busy }] : []),
      ] : []),
      { id: "page", commandId: "creator.navigate", label: "Studio 页面", kind: "select", placement: "overflow", enabled: !busy, value: route.section,
        options: [
          ...STUDIO_NAVIGATION.map(({ route, label }) => ({ value: route.section, label })),
          ...(route.section === "workspace" ? [{ value: route.section, label: studioRouteTitle(route) }] : []),
        ] },
    ]);
  }, [route.section, editingGame, activePanel, busy, catalogSearch]);
  const venueMap = useMemo(() => {
    if (activePanel !== "play" || !project?.cityLayout || baseViewport.status !== "ready") return null;
    const view = baseViewport.engine?.getCitySdkLayoutView();
    if (!view || view.worldRevision !== project.cityLayout.worldRevision || view.seed !== project.cityLayout.seed) return null;
    const anchors = new Map(view.layout.anchors.map(anchor => [anchor.id, view.geometry.get(anchor.geometryRef)?.positionMeters]));
    const roads = view.roadSegments.flatMap(segment => {
      const from = anchors.get(segment.fromAnchorId);
      const middle = anchors.get(segment.checkpointAnchorId);
      const to = anchors.get(segment.toAnchorId);
      return from && middle && to ? [[from, middle, to]] : [];
    });
    return { geometry: view.geometry, roads };
  }, [activePanel, project?.cityLayout, baseViewport]);
  const candidatePanel = <CandidatePanel candidate={candidate} busy={busy} browserPreview={browserPreview} hasUncommittedProjectEdits={hasUncommittedProjectEdits}
    hasMounts={!!project?.mounts.length} publishedReleaseId={publishedReleaseId} onCreate={() => void createCandidate()} onTest={() => void startCandidatePlaytest()}
    onAccept={() => void acceptCandidate()} onPlaytestRelease={() => void startPlaytest()} onDirectPublish={() => void publish()}
    onRemixRelease={() => publishedReleaseId && void remixRelease(publishedReleaseId)} />;
  const entityEngineFor = (source: PreviewViewportSource): CityEngine | null => source === "agent" ? agentPreviewEngineRef.current : source === "draft" ? draftEngineRef.current : studioEngineRef.current;
  const entityScopeFor = (source: PreviewViewportSource): PreviewEntityScope | null => {
    const current = projectRef.current;
    if (!current?.cityId || current.cityRevision === undefined) return null;
    if (source === "draft" && (draftCityViewRef.current?.cityId !== current.cityId || draftCityViewRef.current.revision !== current.cityRevision)) return null;
    if (source === "agent") {
      const taskPreviewMatches = !!activePreview?.sceneOperations && activePreview.projectId === current.projectId && activePreview.revision === current.revision;
      const commitPreviewMatches = agentCommit?.projectId === current.projectId && agentCommit.expectedRevision === current.revision;
      if (!taskPreviewMatches && !commitPreviewMatches) return null;
    }
    const worldRevision = entityEngineFor(source)?.getCitySdkLayoutView()?.worldRevision
      ?? (source === "base" ? current.cityLayout?.worldRevision : undefined);
    return worldRevision ? { projectId: current.projectId, cityId: current.cityId, projectRevision: current.revision,
      cityRevision: current.cityRevision, worldRevision } : null;
  };
  const selectedEntityScope = selectedEntity ? entityScopeFor(selectedEntitySource.current) : null;
  const selectedEntityStatus = selectedEntity ? previewEntityReferenceStatus(selectedEntity, selectedEntityScope) : "wrong-project" as const;
  const selectedEntityVerification = selectedEntity ? entityVerificationLevel(studioTasks.task?.evidence ?? [], selectedEntity) : "none" as const;
  const selectPreviewEntity = (picked: CityEntitySelection | null, source: PreviewViewportSource) => {
    if (!picked) {
      if (selectedEntitySource.current === source) { setSelection(null); setEntityDiagnostic(idlePreviewEntityDiagnostic); }
      return;
    }
    const current = projectRef.current;
    if (!current?.cityId || current.cityRevision === undefined) {
      if (source === "draft" && draftCityViewRef.current) {
        selectedEntitySource.current = source;
        setSelection({ scope: selectionScope, target: picked.label });
        setEntityDiagnostic(idlePreviewEntityDiagnostic);
        openWorkspacePanel("agent");
        setMessage(`已关联独立 City 对象「${picked.label}」；未绑定 Project，因此不会伪造稳定实体引用。`);
      } else setMessage("当前 Project 未绑定独立 City 版本，不能创建稳定的 Preview 对象引用。");
      return;
    }
    if (source === "draft" && (draftCityViewRef.current?.cityId !== current.cityId || draftCityViewRef.current.revision !== current.cityRevision)) {
      setMessage("独立城市预览不属于当前 Project 的绑定版本，请返回项目视图后重新选择对象。"); return;
    }
    let previewId: string | undefined;
    if (source === "agent") {
      if (activePreview?.sceneOperations && activePreview.projectId === current.projectId && activePreview.revision === current.revision) previewId = activePreview.previewId;
      else if (agentCommit?.projectId === current.projectId && agentCommit.expectedRevision === current.revision) previewId = agentCommit.previewId;
      if (!previewId) { setMessage("Agent Preview 已过期，请重新生成预览并选择对象。"); return; }
    }
    const worldRevision = entityEngineFor(source)?.getCitySdkLayoutView()?.worldRevision;
    if (!worldRevision) { setMessage("当前 Preview 的 World Revision 尚未就绪，请稍后重新选择对象。"); return; }
    try {
      const reference = parsePreviewEntityReference({
        schemaVersion: 1, projectId: current.projectId, cityId: current.cityId,
        entityId: picked.entityId, label: picked.label, entityKind: picked.kind,
        projectRevision: current.revision, cityRevision: current.cityRevision, worldRevision,
        ...(previewId ? { previewId } : {}), pose: picked.pose,
      });
      selectedEntitySource.current = source;
      setSelection({ scope: selectionScope, target: reference.label, reference });
      setEntityDiagnostic(idlePreviewEntityDiagnostic);
      openWorkspacePanel("agent");
      setMessage(`已将「${reference.label}」带入 Agent Chat（${reference.entityId} · World ${reference.worldRevision}）。`);
    } catch { setMessage("对象引用无效，请重新选择。"); }
  };
  const focusSelectedEntity = () => {
    if (!selectedEntity || selectedEntityStatus !== "current") { setMessage("对象版本已变化，请在 Preview 重新选择。"); return; }
    const engine = entityEngineFor(selectedEntitySource.current);
    if (!engine?.focusEntity(selectedEntity.entityId)) setMessage("当前 Preview 中找不到这个 entityId；不会改选同名对象，请重新选择。");
  };
  const inspectSelectedEntity = async () => {
    const reference = selectedEntity;
    const source = selectedEntitySource.current;
    if (!reference || previewEntityReferenceStatus(reference, entityScopeFor(source)) !== "current") { setMessage("对象版本已变化，请重新选择后再诊断。"); return; }
    const engine = entityEngineFor(source);
    if (!engine) { setMessage("当前 Preview 引擎不可用，无法诊断。"); return; }
    setEntityDiagnostic({ status: "loading" });
    try {
      const inspection = parseGroundInspection(await engine.inspectGroundContact({
        x: reference.pose.x, z: reference.pose.z, heading: reference.pose.heading,
        ...(reference.support?.regionId ? { regionId: reference.support.regionId } : {}),
      }));
      if (engine.getCitySdkLayoutView()?.worldRevision !== reference.worldRevision) throw new Error("revision_conflict");
      const current = projectRef.current;
      if (!current || current.projectId !== reference.projectId || current.revision !== reference.projectRevision) throw new Error("preview_entity_reference_stale");
      if (selectionRef.current?.reference !== reference) return;
      if (inspection.status === "ready") {
        const supported = attachPreviewEntitySupport(reference, {
          ...(inspection.regionId ? { regionId: inspection.regionId } : {}), ...(inspection.layerId ? { surfaceId: inspection.layerId } : {}),
        });
        setSelection(value => value?.reference === reference ? { ...value, reference: supported } : value);
      }
      setEntityDiagnostic({ status: inspection.status, inspection, persisted: false });
      setMessage("真实接地诊断已返回，但未写入 Task Ledger；结果保留在当前 Preview，不标记为已验证。");
    } catch (error) {
      if (selectionRef.current?.reference !== reference) return;
      const code = errorCode(error, "ground_inspection_unavailable");
      setEntityDiagnostic({ status: "failed", error: code === "revision_conflict" || code === "preview_entity_reference_stale" ? "诊断期间世界版本已变化，请重新选择对象。" : code });
      setMessage(code === "revision_conflict" ? "诊断证据的 World Revision 与对象引用不一致，已丢弃。" : `接地诊断不可用（${code}）。`);
    }
  };
  const viewAgentChanges = () => {
    if (previewLocked && taskPreview?.previewId !== activePreview?.previewId) { setMessage("Preview 已锁定；未切换画面。解锁后再次点击“查看改动”。"); return; }
    const evidence = studioTasks.task?.evidence.find(item => item.kind === "preview" && item.trustLevel === "host-observed"
      && (item.data as { previewId?: unknown } | null)?.previewId === studioTasks.task?.proposedChangeSetId);
    const changed = (evidence?.data as { changedObjects?: unknown } | null)?.changedObjects;
    const ids = Array.isArray(changed) ? changed.flatMap(item => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? [String((item as { id: string }).id)] : []) : [];
    const entityId = selectedEntity && ids.includes(selectedEntity.entityId) ? selectedEntity.entityId : ids[0];
    if (!entityId) { setMessage("当前结果没有可定位的实体 ID，请查看原始差异。"); return; }
    setAgentRevealSignal(value => value + 1);
    if (agentCityPreview) {
      if (agentPreviewStatus?.context !== agentCityPreview || agentPreviewStatus.status !== "ready") { setMessage("Agent 三维 Preview 尚未就绪，就绪后再定位改动。"); return; }
      if (!agentPreviewEngineRef.current?.focusEntity(entityId)) setMessage("Preview 中没有这个 entityId，请重新选择对象；未按名称替换目标。");
      return;
    }
    if (activePreview?.sceneOperations) { setMessage("完整场景 Preview 尚未就绪，不能定位或保存。"); return; }
    if (studioEngineRef.current?.focusEntity(entityId)) setMessage("已定位当前已保存版本中的实体；临时碰撞体差异请结合结果卡查看。");
    else setMessage("当前已保存版本中不存在这个 entityId；新增或删除对象需等待可渲染 Preview。");
  };

  const inspectGroundContact = async (input: { x: number; z: number; heading: number; regionId?: string }) => {
    const city = draftCityViewRef.current; const engine = draftEngineRef.current;
    if (!city || !engine || draftViewStatusRef.current !== "ready") throw new Error("ground_inspection_requires_city");
    return engine.inspectGroundContact(input);
  };

  const diagnostics = <EvidenceCenterPanel request={creatorRequest} browserPreview={browserPreview} activeCity={draftCityView} inspectGround={inspectGroundContact} />;
  const viewport = <CityViewportPanel
    agentFeedback={task?.phase === "executing" || task?.phase === "validating" ? "Agent 正在生成改动"
      : activePreview?.sceneOperations ? agentCityPreview && agentPreviewStatus?.context === agentCityPreview && agentPreviewStatus.status === "ready" ? "完整场景预览已显示 · 等待确认" : `正在准备完整场景预览 · ${scenePreviewGateReason ?? "尚未就绪"}`
      : visibleColliderPreview ? "碰撞体预览已显示 · 等待确认"
      : activePreview?.boxes.length ? "碰撞体待确认 · 当前场景无法定位预览"
      : task?.phase === "awaiting-review" ? "变更待确认 · 在右侧查看详情"
      : task?.phase === "failed" ? "本次任务未生成可预览的改动" : null}
    selectionScope={activePanel === "story" ? "" : selectionScope} getProjectEngine={() => baseViewportStatusRef.current === "ready" ? isolatedProjectEngineRef.current : null}
    onSelectTarget={target => { setSelection({ scope: selectionScope, target }); setEntityDiagnostic(idlePreviewEntityDiagnostic); openWorkspacePanel("agent"); }}
    onEntitySelect={selectPreviewEntity} selectedEntity={selectedEntity} selectedEntityStatus={selectedEntityStatus} selectedEntityVerification={selectedEntityVerification}
    entityDiagnostic={entityDiagnostic} onFocusEntity={focusSelectedEntity} onInspectEntity={() => void inspectSelectedEntity()} projectSceneView={projectSceneView}
    installedWorldView={installedWorldView} draftCityView={draftCityView} draftCityViewRef={draftCityViewRef} draftEngineRef={draftEngineRef}
    draftViewStatusRef={draftViewStatusRef} draftViewFailureRef={draftViewFailureRef} recordCityDiagnostic={recordCityDiagnostic}
    projectCityKey={projectCityKey} projectCity={projectCity} project={project} viewportSeed={viewportSeed} viewportUnavailable={viewportUnavailable}
    worldProfile={worldProfile} focusSignal={focusSignal} busy={busy} browserPreview={browserPreview}
    agentCityPreview={agentCityPreview} agentPreviewId={agentViewportPreviewId} agentRevealSignal={agentRevealSignal}
    onResetView={() => setFocusSignal(value => value + 1)} previewLocked={previewLocked} canLockPreview={!!taskPreview} onTogglePreviewLock={togglePreviewLock} onCloseInstalledWorld={() => setInstalledWorldView(null)}
    onCloseDraftCity={() => { cityOpenRequest.current++; draftCityViewRef.current = null; setDraftCityView(null); }}
    onOpenProject={() => openWorkspacePanel("project")} onExportCitySource={() => void exportCitySource()} onMessage={setMessage}
    setBaseEngine={setBaseEngine} setAgentEngine={engine => { agentPreviewEngineRef.current = engine; }} setBaseStatus={setBaseStatus} commitPatchRef={commitPatchRef}
    onAgentViewportStatus={(status, code) => setAgentPreviewStatus(previous => previous?.context === agentCityPreview && previous.status === status && previous.code === code ? previous : { context: agentCityPreview!, status, code })}
  />;
  return <main className="studio" aria-label={studioRouteTitle(route)}>
    {route.section === "home" && <div className="studio-route-content">
      {message && <p className="status status-banner" role="status">{message}</p>}
      <WorkbenchHome projects={projects} projectsLoading={projectsLoading} projectsError={projectsError} project={project} publishedReleaseId={publishedReleaseId}
        hasPendingApproval={agentCommit !== null} busy={busy} goal={goalDraft} onGoalChange={setGoalDraft} onOpenProject={openProjectInWorkspace} onOpenTemplates={kind => { if (kind === "story") openStoryTool(); else {
          setCatalogStartMode("new"); setRoute(STUDIO_PROJECTS_ROUTE);
        } }}
        onOpenAgent={() => openWorkspacePanel("agent")} onRefreshProjects={refreshProjectCatalog} />
    </div>}
    {route.section === "projects" && <div className="studio-route-content">
      {message && <p className="status status-banner" role="status">{message}</p>}
      <ProjectsPage request={creatorRequest} projects={projects} projectsLoading={projectsLoading} projectsError={projectsError} cities={cities} layouts={layouts} citiesLoading={citiesLoading} citiesError={citiesError} busy={busy} browserPreview={browserPreview}
        search={catalogSearch} onSearchChange={setCatalogSearch} onCreateGame={() => setCatalogStartMode("new")} onOpenStoryTool={() => openStoryTool()}
        start={<CatalogStart mode={catalogStartMode} projects={projects} busy={busy} goal={goalDraft}
          onGoalChange={setGoalDraft} onModeChange={setCatalogStartMode} onOpen={openAgentProjectFromCatalog}
          gameForm={<GameStartForm cities={cities} layouts={layouts} template={template} worldRevision={worldRevision}
            busy={busy || (catalogStartMode === "agent-new" && !normalizeStudioGoal(goalDraft))}
            submitLabel={switchConfirm === "create" ? "确认丢弃草稿并新建" : catalogStartMode === "agent-new" ? "创建并带目标进入编辑器" : "创建项目"}
            onTemplateChange={setTemplate} onLayoutChange={setWorldRevision}
            onSubmit={() => guardDrafts("create", () => void createProject("agent"))}
            codeGameCreating={busy}
            activeCodeTemplateId={codeGameWorkspace?.template ?? null}
            onCreateCodeTemplate={templateId => void createCodeGame(templateId)} />} />}
        onOpenProject={openProjectInWorkspace} onRefreshProjects={refreshProjectCatalog} onOpenCity={openCityInWorkspace}
        onConfigureGame={id => openProjectInWorkspace(id, undefined, "mount")}
        onOpenGamePreview={openCodeGamePreview}
        onOpenStory={openStoryTool}
        onRefreshCities={() => void loadCities()}
        archivedCities={archivedCities} archivesLoading={archivesLoading} archivesError={archivesError} archivePreview={archivePreview}
        onPreviewCityArchive={city => void previewCityArchive(city)} onCommitCityArchive={() => void commitCityArchive()}
        onCancelCityArchivePreview={() => setArchivePreview(null)} onRestoreCityArchive={cityId => void restoreCityArchive(cityId)} />
    </div>}
    {(route.section === "explore" || route.section === "releases") && <div className={route.section === "releases" ? "studio-route-resource release-management" : "studio-route-resource"}>
      {route.section === "releases" && <div className="release-candidate">{candidatePanel}<ExperienceDistributionPanel request={creatorRequest} browserPreview={browserPreview} publishedReleaseId={publishedReleaseId} onMessage={setMessage} /></div>}
      <CityGameLibraryPanel key={route.section} view={route.section} request={creatorRequest} browserPreview={browserPreview} message={message} onMessage={setMessage}
        onOpenPreview={(buildId, source) => openCodeGamePreview(buildId, source?.cityId)} />
    </div>}
    {(route.section === "workspace" || route.section === "evidence") && <div ref={workspaceRef} style={route.section === "workspace" ? workspaceLayout.style : undefined}
      data-focus={route.section === "workspace" ? workspaceLayout.focus : undefined}
      data-sessions-open={narrowSessionsOpen ? "true" : undefined}
      className={route.section === "evidence" ? "workspace studio-workspace evidence-workspace-layout" : "workspace studio-workspace session-centric-workspace"}>
      {route.section === "workspace" && <SessionSidebar scopeTitle={draftCityView?.name ?? project?.title ?? "未选择 Project"}
        projectRevision={taskScope?.revision ?? null} worldRevision={baseViewport.engine?.getCitySdkLayoutView()?.worldRevision ?? project?.cityLayout?.worldRevision ?? null}
        sessions={studioSessions.sessions} activeSessionId={activeSessionId} loading={studioSessions.loading} creating={studioSessions.creating}
        saving={studioSessions.saving} query={studioSessions.query} onQueryChange={studioSessions.setQuery}
        error={studioSessions.error} previewLocked={previewLocked} onSelect={sessionId => { studioSessions.selectSession(sessionId); openWorkspacePanel("agent"); }}
        onCreate={() => { void studioSessions.createSession().then(sessionId => { if (sessionId) openWorkspacePanel("agent"); }); }}
        onRename={(sessionId, label) => studioSessions.renameSession(sessionId, label)}
        onArchive={sessionId => { void studioSessions.archiveSession(sessionId); }}
        onRestore={sessionId => { void studioSessions.restoreSession(sessionId).then(restored => { if (restored) openWorkspacePanel("agent"); }); }} />}
      {route.section === "workspace" && <WorkspaceSplitter kind="sessions" label="调整 Sessions 栏宽" dragging={workspaceLayout.dragging === "sessions"}
        width={workspaceLayout.widths?.sessions ?? 0} min={WORKSPACE_MIN_SESSIONS} max={4000}
        onPointerDown={workspaceLayout.startDrag("sessions")} onPointerMove={workspaceLayout.moveDrag} onPointerUp={workspaceLayout.endDrag}
        onReset={workspaceLayout.reset} onNudge={delta => workspaceLayout.nudge("sessions", delta)} />}
      {route.section === "workspace" ? <WorkspacePreview
        title={draftCityView?.name ?? (installedWorldView ? "世界包预览" : project?.title ?? "城市场景")}
        saveStatus={editingGame ? hasUncommittedProjectEdits ? "未保存" : "草稿已保存" : null}
        step={activePanel === "story" ? { status: "剧情创作" } : nextStep} hasProject={editingGame && activePanel !== "story"} busy={busy} browserPreview={browserPreview}
        contentOpen={contentOpen} onCloseContent={() => setContentOpen(false)} onOpenStory={() => openStoryTool()} onOpenCity={() => openWorkspacePanel("agent")} storyActive={activePanel === "story" && contentOpen}
        toolPanel={<WorkspaceContentDrawer open={contentOpen} panel={activePanel} onClose={() => setContentOpen(false)}
          onSelect={tool => tool === "story" ? openStoryTool() : openWorkspacePanel(tool)}>

        {activePanel === "code" && <CodeGamePreviewPanel request={creatorRequest} browserPreview={browserPreview} requestedBuildId={codePreviewBuildId} requestedSourceCityId={codePreviewSourceCityId} workspaceId={codeGameWorkspace?.workspaceId ?? null} onMessage={setMessage} />}
        {activePanel === "project" && <ProjectPanel
          cities={cities} draftCityView={draftCityView} citiesLoading={citiesLoading} citiesError={citiesError} citiesCursor={citiesCursor}
          busy={busy} browserPreview={browserPreview} packageInspection={packageInspection} installedPackages={installedPackages}
          confirmUninstall={confirmUninstall} setConfirmUninstall={setConfirmUninstall}
          onOpenCity={openCityInWorkspace}
          onLoadCities={cursor => void loadCities(cursor)} onExportSource={() => void exportSource()} onExportExperience={() => void exportExperience()}
          onInspectWorldPackage={() => void inspectWorldPackage()} onInstallInspectedPackage={() => void installInspectedPackage()}
          onValidateInstalledPackage={item => void validateInstalledPackage(item)} onPreviewInstalledPackage={item => void previewInstalledPackage(item)}
          onCreateCityFromInstalledWorld={item => void createCityFromInstalledWorld(item)} onUninstallInstalledPackage={item => void uninstallInstalledPackage(item)}
          cityDraft={cityDraft} onCreateCityDraft={(name, seed) => void createCityDraft(name, seed)} onCommitCityDraft={() => void commitCityDraft()} onCancelCityDraft={() => void cancelCityDraft()}
        />}
        {activePanel === "play" && <>
          {!editingGame && <div className="workspace-game-picker">
            <p>从项目库打开或新建 Game 后，可以在这里配置场地和规则。</p>
            <button type="button" className="secondary" onClick={() => {
              if (storyHasDraft) { setMessage("请先保存或放弃 Story 的未保存编辑。"); return; }
              setRoute(STUDIO_PROJECTS_ROUTE);
            }}>返回项目库</button>
          </div>}
          {editingGame && <GameEditorPanel
          venueGeometry={venueMap?.geometry ?? null} venueRoads={venueMap?.roads ?? []}
          project={project} busy={busy} text={text} sceneText={sceneText} entryAnchorId={entryAnchorId} bindingsText={bindingsText} skinId={skinId}
          previewId={previewId} previewKind={previewKind} hasUncommittedProjectEdits={hasUncommittedProjectEdits}
          focusTarget={editorFocus} onFocusHandled={() => setEditorFocus(null)}
          setText={setText} setSceneText={setSceneText} setEntryAnchorId={setEntryAnchorId} setBindingsText={setBindingsText} setSkinId={setSkinId}
          setPreviewId={setPreviewId} setPreviewKind={setPreviewKind} onPreviewGame={() => void preview()} onPreviewScene={() => void previewScene()}
          onImportModel={() => void importModel()} onPreviewMount={() => void previewMount()} onPreviewSkin={value => void previewSkin(value)} onCommit={() => void commit()}
          onOpenProject={() => openWorkspacePanel("project")} onMessage={setMessage}
        />}</>}
          {storyTool && <div hidden={activePanel !== "story"} className="workspace-story-tool">
            <StoryEditorPanel request={creatorRequest} browserPreview={browserPreview} initialStoryId={storyTool.storyId} agentSlot={storyAgentSlot} onDraftStateChange={setStoryHasDraft} taskController={studioTasks} onTaskScopeChange={setStoryTaskScope} />
          </div>}
        </WorkspaceContentDrawer>}
        releaseRequest={releaseRequest} onAction={handleWorkspaceAction} playtest={candidatePanel} diagnostics={diagnostics}
        focus={workspaceLayout.focus} onToggleFocus={workspaceLayout.toggleFocus}>{viewport}</WorkspacePreview> : viewport}
      {route.section === "workspace" && <WorkspaceSplitter kind="agent" label="调整对话栏宽" dragging={workspaceLayout.dragging === "agent"}
        width={workspaceLayout.widths?.agent ?? 0} min={WORKSPACE_MIN_AGENT} max={4000}
        onPointerDown={workspaceLayout.startDrag("agent")} onPointerMove={workspaceLayout.moveDrag} onPointerUp={workspaceLayout.endDrag}
        onReset={workspaceLayout.reset} onNudge={delta => workspaceLayout.nudge("agent", delta)} />}
      {route.section === "workspace" && <aside className="panel" aria-label="Agent 创作伙伴">
        <div className="inspector-heading"><h2>Agent 创作伙伴</h2></div>
        {message && <p className="status status-banner" role="status">{message}</p>}

        <div hidden={activePanel === "story"}><AgentWorkspace project={project} taskController={studioTasks} browserPreview={browserPreview} agentCommit={agentCommit} agentActivity={agentActivity} agentCityPreview={agentCityPreview} agentPreviewStatus={agentPreviewStatus} busy={busy} onToggleSessions={() => setNarrowSessionsOpen(value => !value)}
          goal={activeSessionId ? studioSessions.draft : draftCityView?.cityId ? cityGoals.get(draftCityView.cityId) ?? "" : project ? projectGoals.get(project.projectId) ?? "" : ""}
          onGoalChange={goal => { if (activeSessionId) studioSessions.setDraft(goal); else if (draftCityView) updateCityGoal(draftCityView.cityId, goal); else if (project) updateProjectGoal(project.projectId, goal); }} onResolve={resolveAgentCommit}
          commitBlockedReason={studioTasks.task ? taskCommitBlockedReason(studioTasks.task, taskScope ? ("projectId" in taskScope ? taskScope.projectId : taskScope.cityId) : null, taskScope?.revision ?? null, hasUncommittedProjectEdits)
            ?? (scenePreviewRequired
              ? !taskPreview ? "场景 Preview 已过期或本地预览记录不可用；请重新生成 Preview。"
                : previewLocked && taskPreview.previewId !== activePreview?.previewId ? "Preview 已锁定；解锁并查看本次改动后才能确认保存。"
                : !taskPreview.sceneOperations ? "本次修改包含无法完整显示的混合操作；请拆分为场景对象修改后重新预览。"
                : !agentCityPreview || agentPreviewStatus?.context !== agentCityPreview || agentPreviewStatus.status !== "ready"
                  ? "完整场景 Preview 尚未就绪或加载失败；确认保存前必须看到真实改动。" : null
              : null) : null}
          target={selection?.scope === selectionScope ? selection.target : undefined}
          targetReference={selectedEntity ? { kind: "city", reference: selectedEntity } : undefined} targetReferenceStatus={selectedEntityStatus}
          onClearTarget={() => { setSelection(null); setEntityDiagnostic(idlePreviewEntityDiagnostic); }} onViewChanges={viewAgentChanges}
          scopeTitle={draftCityView?.name} scopeReady={!!taskScope && !busy} /></div>
        <div ref={setStoryAgentSlot} hidden={activePanel !== "story"} className="story-agent-slot" />

      </aside>}
      {route.section === "evidence" && <aside className="panel evidence-workspace" aria-label="证据中心工作区">{diagnostics}</aside>}
    </div>}
    {route.section !== "projects" && route.section !== "workspace" && <footer className="studio-status" role="status"><span>{route.section === "home" ? "从创作目标或真实最近项目开始" : route.section === "evidence" ? "真实 Candidate / Build / Run / Trace / Ground 证据" : route.section === "explore" ? "City 实例与 Game Build 分离管理；Story 可在工作区创作" : route.section === "releases" ? "真实 Build 与 Installation；候选发布后端待接入" : ""}</span><span>{route.section === "home" ? "复制目标不会创建或执行 Agent Task" : route.section === "evidence" ? "信任级与 Host 分歧必须可见；本地 Ground 查询不写 Run" : route.section === "explore" ? "Story Registry 已接入；安装关系需单独确认" : route.section === "releases" ? "安装预检与更新确认门控保持不变" : ""}</span></footer>}
  </main>;
}
