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
import { useStudioTasks } from "../features/agent/useStudioTasks";
import { useCreatorHostBridge } from "./useCreatorHostBridge";
import { CodeGamePreviewPanel } from "../features/preview/CodeGamePreviewPanel";
import { creatorWorkKindForProject, type ReleaseRef } from "../contracts/creatorProject";
import { layoutSelectionKey, type CityDiagnosticContext, type CityRow, type CityViewOpenResult, type CityViewStatus, type CityWorldSnapshot, type LayoutRow, type Project, type ProjectCityState, type ProjectRow, type SceneDraft, type StudioPanel } from "../contracts/creatorStudio";
import { browserPreview, creatorRequest } from "../adapters/creatorHost";
import { digest, errorCode } from "../adapters/creatorHostUtils";
import { CityGameLibraryPanel } from "../features/library/CityGameLibraryPanel";
import { CityViewportPanel } from "../features/city/CityViewportPanel";
import { CityDraftPanel } from "../features/city/CityDraftPanel";
import { CityArchivePanel } from "../features/city/CityArchivePanel";
import { canCommitArchive, cityDraftValidation, DRAFT_CITY_PROFILE, parseArchivePreview, parseArchivedCities, parseCityDraft, type ArchivedCity, type CityArchivePreview, type CityDraft } from "../contracts/cityLifecycle";
import { GameEditorPanel } from "../features/project/GameEditorPanel";
import { ProjectPanel } from "../features/project/ProjectPanel";
import { ProjectsPage } from "../features/project/ProjectsPage";
import { WorkbenchHome } from "../features/home/WorkbenchHome";
import { StoryEditorPanel } from "../features/story/StoryEditorPanel";
import { EvidenceCenterPanel } from "../features/evidence/EvidenceCenterPanel";
import { CandidatePanel } from "../features/project/CandidatePanel";
import { canAcceptCandidate, parseProjectCandidate, type ProjectCandidate } from "../contracts/candidate";
import { StudioNavigation } from "./StudioNavigation";
import { STUDIO_HOME_ROUTE, STUDIO_WORKSPACE_ROUTE, type StudioRoute } from "./studioRoute";
import { readCityAppearancePreference } from "../../../../agent-city/ui/src/engine/cityWorldProfile";
import type { CityEngine } from "../../../../agent-city/ui/src/engine/CityEngine";
import { CITY_GENERATOR_VERSION, type PlanPatchV1 } from "../../../../agent-city/ui/src/engine/planPatch";

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
  const [packageInspection, setPackageInspection] = useState<WorldPackageInspection | null>(null);
  const [installedPackages, setInstalledPackages] = useState<ReadonlyArray<InstalledContentPackage>>([]);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [route, setRoute] = useState<StudioRoute>(STUDIO_HOME_ROUTE);
  const [activePanel, setActivePanel] = useState<StudioPanel>("play");
  const openWorkspacePanel = (panel: StudioPanel) => { setActivePanel(panel); setRoute(STUDIO_WORKSPACE_ROUTE); };
  const [codePreviewBuildId, setCodePreviewBuildId] = useState<string | undefined>(undefined);
  const [codePreviewSourceCityId, setCodePreviewSourceCityId] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState("");
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
  const studioTasks = useStudioTasks(creatorRequest, project);
  const approvalGate = useRef(new AgentApprovalGate());
  const [agentCommit, setAgentCommit] = useState<AgentCommit | null>(null);
  const [agentPreviewStatus, setAgentPreviewStatus] = useState<{ context: object; status: "loading" | "ready" | "failed"; code?: string } | null>(null);
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
    entry: p.mounts?.[0]?.entryAnchorId ?? p.cityLayout?.layout.anchors.find(anchor => anchor.kind === "spawn")?.id ?? "",
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
    if (!sameProject || previous?.revision !== next.revision) { setPublishedReleaseId(null); setCandidate(null); }
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
  const setBaseEngine = (engine: CityEngine | null) => {
    studioEngineRef.current = engine;
    setBaseViewport({ engine, status: "loading" });
  };
  const setBaseStatus = (status: "loading" | "ready" | "failed") => {
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
    }).catch(() => {
      if (epoch !== candidateEpoch.current) return;
      const current = projectRef.current;
      if (current && (current.projectId !== projectId || current.revision !== revision)) return;
      setCandidate(null);
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
  const openProjectInWorkspace = (projectId: string) => guardDrafts(projectId, () => {
    openWorkspacePanel("play");
    void openProject(projectId);
  });
  const openCityInWorkspace = (cityId: string, revision: number) => {
    openWorkspacePanel("project");
    setBusy(true);
    void openCityView(cityId, revision).catch(error => {
      const code = errorCode(error, "creator_city_view_failed");
      setMessage(code === "revision_conflict" ? "城市版本已变化，请刷新列表后重新打开。" : `无法打开城市（${code}）。`);
      void loadCities();
    }).finally(() => setBusy(false));
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
    setInstalledWorldView(null);
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
  useCreatorHostBridge({
    projectRef, applyRef, studioEngineRef, draftCityViewRef, draftEngineRef, draftViewStatusRef, draftViewFailureRef, draftDiagnosticsRef,
    approvalGate, openCityView, recordCityDiagnostic, recordAgentActivity, restoreAgentActivity, setAgentCommit, setMessage, setActivePanel: openWorkspacePanel,
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
        openWorkspacePanel("play");
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
    } catch (error) {
      const code = errorCode(error, "creator_read_failed");
      if (code === "creator_project_not_found" || code === "not_found") forgetStudioProject(window.localStorage);
      setMessage(error instanceof Error ? error.message : "creator_read_failed");
    }
    finally { setBusy(false); }
  };
  const createProject = async () => {
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
      setPendingCreateId(null);
      await refresh(); await openProject(created.projectId); openWorkspacePanel("play");
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
          if (spec) throw new Error(`“${slot === "points" ? "检查点" : slot === "targets" ? "收集目标" : slot}”需要 ${spec.min} 至 ${spec.max} 个，当前已选 ${count} 个。`);
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
  const hasUncommittedProjectEdits = !!project && (
    text !== JSON.stringify(project.game, null, 2)
    || sceneText !== JSON.stringify(project.scene ?? { schemaVersion: 1, objects: [] }, null, 2)
    || !bindingsMatch(bindingsText, project.mounts?.[0]?.bindings ?? {})
    || entryAnchorId !== (project.mounts?.[0]?.entryAnchorId ?? project.cityLayout?.layout.anchors.find(anchor => anchor.kind === "spawn")?.id ?? "")
    || skinId !== (project.skinId ?? "miami-vice")
  );

  // A second, read-only renderer keeps the original edit session and its pending saves alive.
  // Only a single complete patch can be shown faithfully; mixed operations stay blocked.
  const agentCityPreview = useMemo(() => {
    const raw = agentCommit?.proposal.cityPatch;
    if (!agentCommit?.proposal.requiresCityPreview || !raw || typeof raw !== "object" || Array.isArray(raw)
      || !project || project.projectId !== agentCommit.projectId || project.revision !== agentCommit.expectedRevision
      || hasUncommittedProjectEdits || draftCityView || viewportSeed === null || !project.cityLayout?.worldRevision || (raw as { seed?: unknown }).seed !== viewportSeed) return null;
    if (baseViewport.status !== "ready" || baseViewport.engine !== studioEngineRef.current || !matchesPreviewBase(baseViewport.engine, viewportSeed, project.cityLayout.worldRevision)) return null;
    if (projectCityKey && (!projectCity?.city || projectCity.key !== projectCityKey || !validateWorldPlanPatch(raw, viewportSeed, CITY_GENERATOR_VERSION).ok)) return null;
    return { patch: raw as PlanPatchV1, seed: viewportSeed, worldRevision: project.cityLayout.worldRevision, baseEngine: baseViewport.engine, isolated: !!projectCityKey,
      profile: projectCityKey ? projectCity!.city!.profile : worldProfile };
  }, [agentCommit, project, hasUncommittedProjectEdits, draftCityView, viewportSeed, projectCityKey, projectCity, worldProfile, baseViewport]);

  const resolveAgentCommit = async (approve: boolean) => {
    const pending = agentCommit;
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

  let visualSlot: "points" | "targets" | null = null;
  let slotMinimum = 0;
  try {
    const slots = JSON.parse(text)?.slots;
    if (slots && Object.keys(slots).length === 1 && ("points" in slots || "targets" in slots)) visualSlot = "points" in slots ? "points" : "targets";
    if (visualSlot && Number.isInteger(slots[visualSlot]?.min)) slotMinimum = slots[visualSlot].min;
  } catch { /* 高级规则无效时不猜测绑定方式 */ }
  const releaseHint = browserPreview && publishedReleaseId && !hasUncommittedProjectEdits ? "浏览器预览不支持试玩，请在桌面应用中试玩" : !project ? "先打开或创建项目" : hasUncommittedProjectEdits ? "请先保存未提交的修改" : !project.mounts?.length ? "请先配置并保存玩法场地" : !publishedReleaseId ? "发布后即可试玩当前版本" : "已发布版本可供试玩";

  // 宿主工具栏选项限制为 8 项、值不超过 32 字节；用索引作为短值，
  // 超出的项目仍可在项目面板中访问，避免向宿主泄漏或截断项目 ID。
  const toolbarProjects = project && !projects.slice(0, 6).some(row => row.projectId === project.projectId)
    ? [projects.find(row => row.projectId === project.projectId), ...projects.slice(0, 6)].filter((row): row is ProjectRow => !!row)
    : projects.slice(0, 7);
  const toolbarActionRef = useRef<(commandId: string, value?: string) => void>(() => {});
  toolbarActionRef.current = (commandId, value) => {
    if (commandId === "creator.project") {
      if (value === "more") { openWorkspacePanel("project"); return; }
      const row = toolbarProjects[Number(value)];
      if (row && row.projectId !== project?.projectId) openProjectInWorkspace(row.projectId);
    } else if (commandId === "creator.candidate.create" && !browserPreview && !busy && !candidate && project && !hasUncommittedProjectEdits && project.mounts.length) void createCandidate();
    else if (commandId === "creator.candidate.test" && !busy && candidate && candidate.status !== "testing" && candidate.status !== "accepted" && candidate.status !== "unknown" && !hasUncommittedProjectEdits) void startCandidatePlaytest();
    else if (commandId === "creator.candidate.accept" && !busy && !hasUncommittedProjectEdits && canAcceptCandidate(candidate)) void acceptCandidate();
    else if (commandId === "creator.playtest" && !busy && publishedReleaseId && !hasUncommittedProjectEdits) void startPlaytest();
    else if (commandId === "creator.publish" && !busy && project && !hasUncommittedProjectEdits && project.mounts?.length) void publish();
  };
  useEffect(() => connect(command => toolbarActionRef.current(command.commandId, command.value)), []);
  const openProjectWorkKind = project ? creatorWorkKindForProject(project.kind) : null;
  useEffect(() => {
    const selected = toolbarProjects.findIndex(row => row.projectId === project?.projectId);
    publishToolbar([
      { id: "project", commandId: "creator.project", label: openProjectWorkKind === "game" ? "选择模板 Game 项目" : "选择项目", kind: "select", enabled: !busy,
        value: selected < 0 ? "more" : String(selected), options: [
          ...toolbarProjects.map((row, index) => ({ value: String(index), label: `${row.title} · 版本 ${row.revision}`.slice(0, 100) })),
          { value: "more", label: project ? "更多项目…" : "选择项目…" },
        ] },
      { id: "candidate-create", commandId: "creator.candidate.create", label: "创建 Candidate", kind: "button", enabled: !browserPreview && !busy && !candidate && !!project && !hasUncommittedProjectEdits && !!project.mounts.length },
      { id: "candidate-test", commandId: "creator.candidate.test", label: "试玩 Candidate", kind: "button", enabled: !browserPreview && !busy && !!candidate && candidate.status !== "testing" && candidate.status !== "accepted" && candidate.status !== "unknown" && !hasUncommittedProjectEdits },
      { id: "candidate-accept", commandId: "creator.candidate.accept", label: "接受并发布", kind: "button", enabled: !busy && !hasUncommittedProjectEdits && canAcceptCandidate(candidate) },
      { id: "playtest", commandId: "creator.playtest", label: "试玩 Release", kind: "button", enabled: !browserPreview && !busy && !!publishedReleaseId && !hasUncommittedProjectEdits },
      { id: "publish", commandId: "creator.publish", label: "直接发布", kind: "button", enabled: !busy && !!project && !hasUncommittedProjectEdits && !!project.mounts?.length },
    ]);
  }, [projects, project, busy, candidate, publishedReleaseId, hasUncommittedProjectEdits]);
  const candidatePanel = <CandidatePanel candidate={candidate} busy={busy} browserPreview={browserPreview} hasUncommittedProjectEdits={hasUncommittedProjectEdits}
    hasMounts={!!project?.mounts.length} publishedReleaseId={publishedReleaseId} onCreate={() => void createCandidate()} onTest={() => void startCandidatePlaytest()}
    onAccept={() => void acceptCandidate()} onPlaytestRelease={() => void startPlaytest()} onDirectPublish={() => void publish()} />;
  const inspectGroundContact = async (input: { x: number; z: number; heading: number; regionId?: string }) => {
    const city = draftCityViewRef.current; const engine = draftEngineRef.current;
    if (!city || !engine || draftViewStatusRef.current !== "ready") throw new Error("ground_inspection_requires_city");
    return engine.inspectGroundContact(input);
  };

  return <main className="studio">
    <StudioNavigation route={route} projectTitle={project?.title ?? project?.projectId} onNavigate={setRoute} />
    {route.section === "home" && <div className="studio-route-content">
      {message && <p className="status status-banner" role="status">{message}</p>}
      <WorkbenchHome projects={projects} projectsLoading={projectsLoading} projectsError={projectsError} project={project} publishedReleaseId={publishedReleaseId}
        hasPendingApproval={agentCommit !== null} busy={busy} onOpenProject={openProjectInWorkspace} onOpenTemplates={kind => { if (kind === "story") setRoute({ section: "stories" }); else openWorkspacePanel("project"); }}
        onOpenAgent={() => openWorkspacePanel("agent")} onRefreshProjects={refreshProjectCatalog} />
    </div>}
    {route.section === "projects" && <div className="studio-route-content">
      {message && <p className="status status-banner" role="status">{message}</p>}
      <ProjectsPage projects={projects} projectsLoading={projectsLoading} projectsError={projectsError} cities={cities} citiesLoading={citiesLoading} citiesError={citiesError} busy={busy} browserPreview={browserPreview}
        onOpenProject={openProjectInWorkspace} onRefreshProjects={refreshProjectCatalog} onOpenCity={openCityInWorkspace}
        onRefreshCities={() => void loadCities()} onCreateProject={() => openWorkspacePanel("project")}
        archivedCities={archivedCities} archivesLoading={archivesLoading} archivesError={archivesError} archivePreview={archivePreview}
        onPreviewCityArchive={city => void previewCityArchive(city)} onCommitCityArchive={() => void commitCityArchive()}
        onCancelCityArchivePreview={() => setArchivePreview(null)} onRestoreCityArchive={cityId => void restoreCityArchive(cityId)} />
    </div>}
    {route.section === "stories" && <div className="studio-route-content story-route-content"><StoryEditorPanel request={creatorRequest} browserPreview={browserPreview} /></div>}
    {(route.section === "explore" || route.section === "releases") && <div className={route.section === "releases" ? "studio-route-resource release-management" : "studio-route-resource"}>
      {route.section === "releases" && <div className="release-candidate">{candidatePanel}</div>}
      <CityGameLibraryPanel key={route.section} view={route.section} request={creatorRequest} browserPreview={browserPreview} message={message} onMessage={setMessage}
        onOpenPreview={(buildId, source) => { setCodePreviewBuildId(buildId); setCodePreviewSourceCityId(source?.cityId); openWorkspacePanel("code"); }} />
    </div>}
    {(route.section === "workspace" || route.section === "evidence") && <div className={route.section === "evidence" ? "workspace studio-workspace evidence-workspace-layout" : "workspace studio-workspace"}>
      <CityViewportPanel
        installedWorldView={installedWorldView} draftCityView={draftCityView} draftCityViewRef={draftCityViewRef} draftEngineRef={draftEngineRef}
        draftViewStatusRef={draftViewStatusRef} draftViewFailureRef={draftViewFailureRef} recordCityDiagnostic={recordCityDiagnostic}
        projectCityKey={projectCityKey} projectCity={projectCity} project={project} viewportSeed={viewportSeed} viewportUnavailable={viewportUnavailable}
        worldProfile={worldProfile} focusSignal={focusSignal} busy={busy} browserPreview={browserPreview}
        agentCityPreview={agentCityPreview} agentPreviewId={agentCommit?.previewId}
        onResetView={() => setFocusSignal(value => value + 1)} onCloseInstalledWorld={() => setInstalledWorldView(null)}
        onCloseDraftCity={() => { cityOpenRequest.current++; draftCityViewRef.current = null; setDraftCityView(null); }}
        onOpenProject={() => openWorkspacePanel("project")} onExportCitySource={() => void exportCitySource()} onMessage={setMessage}
        setBaseEngine={setBaseEngine} setBaseStatus={setBaseStatus} commitPatchRef={commitPatchRef}
        onAgentViewportStatus={(status, code) => setAgentPreviewStatus(previous => previous?.context === agentCityPreview && previous.status === status && previous.code === code ? previous : { context: agentCityPreview!, status, code })}
      />
      {route.section === "workspace" && <aside className="panel" aria-label="创作检查器">
        <div className="inspector-heading"><div><span className="sidebar-kicker">INSPECTOR</span><h2>{activePanel === "agent" ? "City Agent" : activePanel === "project" ? openProjectWorkKind === "game" ? "模板 Game 项目" : "项目" : activePanel === "code" ? "代码预览" : "玩法与场地"}</h2></div>{project && <span className="version-pill">版本 {project.revision}</span>}</div>
        <nav className="inspector-tabs" aria-label="作品工作区工具"><button className={activePanel === "play" ? "active" : ""} aria-pressed={activePanel === "play"} onClick={() => openWorkspacePanel("play")}>玩法</button><button className={activePanel === "agent" ? "active" : ""} aria-pressed={activePanel === "agent"} onClick={() => openWorkspacePanel("agent")}>Agent</button><button className={activePanel === "project" ? "active" : ""} aria-pressed={activePanel === "project"} onClick={() => openWorkspacePanel("project")}>项目设置</button><button className={activePanel === "code" ? "active" : ""} aria-pressed={activePanel === "code"} onClick={() => openWorkspacePanel("code")}>代码预览</button></nav>
        {message && <p className="status status-banner" role="status">{message}</p>}
        <p className="readiness">{browserPreview ? "合成数据预览 · " : ""}{releaseHint}</p>
        {(activePanel === "play" || activePanel === "project") && project && candidatePanel}
        {activePanel === "code" && <CodeGamePreviewPanel request={creatorRequest} browserPreview={browserPreview} requestedBuildId={codePreviewBuildId} requestedSourceCityId={codePreviewSourceCityId} onMessage={setMessage} />}
        {activePanel === "agent" && <AgentWorkspace project={project} taskController={studioTasks} agentCommit={agentCommit} agentActivity={agentActivity} agentCityPreview={agentCityPreview} agentPreviewStatus={agentPreviewStatus} busy={busy} onResolve={resolveAgentCommit} />}
        {activePanel === "project" && <ProjectPanel
          cities={cities} draftCityView={draftCityView} citiesLoading={citiesLoading} citiesError={citiesError} citiesCursor={citiesCursor}
          busy={busy} browserPreview={browserPreview} packageInspection={packageInspection} installedPackages={installedPackages}
          confirmUninstall={confirmUninstall} projects={projects} project={project} switchConfirm={switchConfirm}
          layouts={layouts} template={template} worldRevision={worldRevision} setTemplate={setTemplate} setWorldRevision={setWorldRevision} setConfirmUninstall={setConfirmUninstall}
          onOpenCity={openCityInWorkspace}
          onLoadCities={cursor => void loadCities(cursor)} onExportSource={() => void exportSource()} onExportExperience={() => void exportExperience()}
          onInspectWorldPackage={() => void inspectWorldPackage()} onInstallInspectedPackage={() => void installInspectedPackage()}
          onValidateInstalledPackage={item => void validateInstalledPackage(item)} onPreviewInstalledPackage={item => void previewInstalledPackage(item)}
          onCreateCityFromInstalledWorld={item => void createCityFromInstalledWorld(item)} onUninstallInstalledPackage={item => void uninstallInstalledPackage(item)}
          onSelectProject={row => { if (row.projectId !== project?.projectId) guardDrafts(row.projectId, () => void openProject(row.projectId)); else { setInstalledWorldView(null); if (draftCityView) { cityOpenRequest.current++; draftCityViewRef.current = null; setDraftCityView(null); } } }}
          onCreateProject={() => guardDrafts("create", () => void createProject())}
          cityDraft={cityDraft} onCreateCityDraft={(name, seed) => void createCityDraft(name, seed)} onCommitCityDraft={() => void commitCityDraft()} onCancelCityDraft={() => void cancelCityDraft()}
        />}
        {activePanel === "play" && <GameEditorPanel
          project={project} busy={busy} text={text} sceneText={sceneText} entryAnchorId={entryAnchorId} bindingsText={bindingsText} skinId={skinId}
          previewId={previewId} previewKind={previewKind} hasUncommittedProjectEdits={hasUncommittedProjectEdits} visualSlot={visualSlot} slotMinimum={slotMinimum}
          setText={setText} setSceneText={setSceneText} setEntryAnchorId={setEntryAnchorId} setBindingsText={setBindingsText} setSkinId={setSkinId}
          setPreviewId={setPreviewId} setPreviewKind={setPreviewKind} onPreviewGame={() => void preview()} onPreviewScene={() => void previewScene()}
          onImportModel={() => void importModel()} onPreviewMount={() => void previewMount()} onPreviewSkin={value => void previewSkin(value)} onCommit={() => void commit()}
          onOpenProject={() => openWorkspacePanel("project")} onMessage={setMessage}
        />}
      </aside>}
      {route.section === "evidence" && <aside className="panel evidence-workspace" aria-label="证据中心工作区"><EvidenceCenterPanel request={creatorRequest} browserPreview={browserPreview} activeCity={draftCityView} inspectGround={inspectGroundContact} /></aside>}
    </div>}
    <footer className="studio-status" role="status"><span>{route.section === "home" ? "从创作目标或真实最近项目开始" : route.section === "projects" ? "Creator Project 与 City Instance 分类管理" : route.section === "stories" ? "独立 Story 草稿；保存不影响已安装 Run" : route.section === "evidence" ? "真实 Candidate / Build / Run / Trace / Ground 证据" : route.section === "explore" ? "City 实例与 Game Build 分离管理；Story 可在 Story Editor 创作" : route.section === "releases" ? "真实 Build 与 Installation；候选发布后端待接入" : !project ? "未选择项目" : hasUncommittedProjectEdits ? "有未保存修改" : `项目版本 ${project.revision}`}</span><span>{route.section === "home" ? "复制目标不会创建或执行 Agent Task" : route.section === "projects" ? "打开最近项目会保留现有草稿状态" : route.section === "stories" ? "Graph/Canon 校验与条件测试不等于 City Run 证据" : route.section === "evidence" ? "信任级与 Host 分歧必须可见；本地 Ground 查询不写 Run" : route.section === "explore" ? "Story Registry 已接入；安装关系需单独确认" : route.section === "releases" ? "安装预检与更新确认门控保持不变" : browserPreview ? "合成数据预览" : releaseHint}</span></footer>
  </main>;
}
