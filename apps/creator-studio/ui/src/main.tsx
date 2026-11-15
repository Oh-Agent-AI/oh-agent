import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { connect, connectHostCalls, invokeHost, observeHealth, publishToolbar } from "@agent-vitals/app-sdk/ui-host";
import { canonicalJson, defaultVehicleCameraV1, validateCityInstance, validateCityLayoutScope, validateCityLayoutSnapshot, validateMiniGamePack, validateMount, validateSceneDraft, validateVehicleProfileV1, validateWorldPlanPatch, type CityGameMountV1, type CityInstanceV1, type CityLayoutSnapshotV1, type CityWorldProfileV1, type VehicleProfileV1 } from "@agent-vitals/city-sdk";
import { applyCityWorldOperations } from "./cityWorldOperations";
import { buildGameValidation, buildSceneValidation, buildVehicleValidation, normalizeVehicleProfileInput, scopeMismatchEnvelope } from "./sdkValidation";
import { loadStudioAtStartup } from "./startupLoad";
import { resolveProjectCity } from "./projectCityScope";
import { formatWorldPackageInspection, parseWorldPackageInspection, type WorldPackageInspection } from "./contentPackageInspect";
import { formatInstalledPackage, parseInstalledPackages, parseInstallResult, type InstalledContentPackage } from "./installedContent";
import { inspectInstalledWorld, supportsInstalledWorldGenerator } from "./contentSnapshot";
import { buildCitySourceExport, buildProjectSourceExport } from "./projectSourceExport";
import { AgentApprovalGate, matchesPreviewBase, type AgentCommit } from "./agentApproval";
// 视口与 City 插件共享同一份引擎与装配管线，保证 Studio 看到的是同一座城市。
import { CityViewport } from "../../../agent-city/ui/src/viewport/CityViewport";
import { createCreatorLayoutSnapshot } from "../../../agent-city/ui/src/engine/sdk/cityLayoutAdapter";
import { readCityAppearancePreference } from "../../../agent-city/ui/src/engine/cityWorldProfile";
import type { CityEngine } from "../../../agent-city/ui/src/engine/CityEngine";
import { CITY_GENERATOR_VERSION, type PlanPatchV1 } from "../../../agent-city/ui/src/engine/planPatch";
import "./style.css";

type ProjectRow = { projectId: string; revision: number; title: string; updatedAtMs: number };
type LayoutRow = { worldRevision: string; layoutId: string; seed: number; anchorCount: number; updatedAtMs: number; cityId?: string; cityRevision?: number; source?: "legacy" | "cityDraft" };
type CityRow = { cityId: string; revision: number; name: string };
type CityWorldSnapshot = Awaited<ReturnType<typeof inspectInstalledWorld>>;
type SceneDraft = { schemaVersion: 1; objects: Array<Record<string, unknown>> };
// 试玩历史行（creator.project.playtest.history 返回的 runs 元素），状态沿用后端英文枚举不翻译。
type PlaytestRun = { runId: string; releaseId: string; revision: number; status: "pending" | "claimed" | "completed" | "cancelled" | "failed" | "expired"; createdAtMs: number; finishedAtMs: number | null; evidenceSource: string | null; evidence: unknown; failureCode: string | null };
type Project = { projectId: string; revision: number; title?: string; kind: string; game: unknown; cityId?: string; cityRevision?: number; cityLayout?: CityLayoutSnapshotV1 | null; cityPatch?: Record<string, unknown> | null; scene?: SceneDraft; assets?: { schemaVersion: 1; entries: Array<{ assetId: string; relativePath: string; sha256: string; byteLength: number; format: "glb-v2"; boundsMeters?: { x: number; y: number; z: number } }> }; assetRefs?: Array<Record<string, unknown>>; mounts: CityGameMountV1[]; skinId?: string };
type PluginResponse<T> = { version: number; requestId: string; ok: boolean; result?: T; error?: { code: string } };
let sequence = 0;
const layoutSelectionKey = (layout: LayoutRow): string => layout.cityId ? `${layout.cityId}::${layout.worldRevision}` : layout.worldRevision;
// 浏览器预览（ui-dev 工作台 iframe）：有插件实例但没有原生宿主，数据来自合成夹具。
const browserPreview = typeof window !== "undefined" && window.parent !== window
  && !(window as Window & { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core?.invoke;

function errorCode(error: unknown, fallback: string): string {
  const candidate = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^[a-z][a-z0-9_]{0,63}$/.test(candidate) ? candidate : fallback;
}

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

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function creatorRequest<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const instanceId = (window as Window & { __AV_PLUGIN_INSTANCE__?: string }).__AV_PLUGIN_INSTANCE__;
  if (!instanceId) throw new Error("creator_studio_not_running_in_host");
  const requestId = `creator-ui:${++sequence}`;
  let response: PluginResponse<T>;
  try { response = await invokeHost<PluginResponse<T>>("plugin_request", { request: { version: 1, instanceId, requestId, method, payload } }); }
  catch (error) { throw new Error(errorCode(error, "creator_request_failed")); }
  if (response.version !== 1 || response.requestId !== requestId) throw new Error("creator_response_invalid");
  if (!response.ok || response.result === undefined) throw new Error(response.error?.code ?? "creator_request_failed");
  return response.result;
}

function App() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [layouts, setLayouts] = useState<LayoutRow[]>([]);
  // 世界外观偏好与 City 同源（同源 WebView 共享 localStorage）；打开期间不追踪 City 侧更改。
  const [worldProfile] = useState(() => readCityAppearancePreference());
  const [project, setProject] = useState<Project | null>(null);
  const [projectCity, setProjectCity] = useState<{ key: string; city: CityInstanceV1 | null; worldScene?: CityWorldSnapshot; error?: string } | null>(null);
  const [draftCityView, setDraftCityView] = useState<CityInstanceV1 | null>(null);
  const [installedWorldView, setInstalledWorldView] = useState<Awaited<ReturnType<typeof inspectInstalledWorld>> | null>(null);
  const draftCityViewRef = useRef<CityInstanceV1 | null>(null);
  const cityOpenRequest = useRef(0);
  const draftEngineRef = useRef<CityEngine | null>(null);
  const draftViewStatusRef = useRef<"loading" | "ready" | "failed">("loading");
  const draftViewFailureRef = useRef<string | undefined>(undefined);
  const draftDiagnosticsRef = useRef<{ cityId: string; revision: number; correlationId: string; started: number; unavailable: boolean } | null>(null);
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
  const scopedProjectPatch = projectCity?.city ? project?.cityPatch ?? projectCity.city.planPatch : null;
  const isolatedPatchResult = projectCityKey && projectCity?.key === projectCityKey && projectCity.city && scopedProjectPatch
    ? validateWorldPlanPatch(scopedProjectPatch, projectCity.city.seed, CITY_GENERATOR_VERSION) : null;
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
  const [packageInspection, setPackageInspection] = useState<WorldPackageInspection | null>(null);
  const [installedPackages, setInstalledPackages] = useState<ReadonlyArray<InstalledContentPackage>>([]);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activePanel, setActivePanel] = useState<"play" | "agent" | "project">("agent");
  const [message, setMessage] = useState("");
  const [cities, setCities] = useState<CityRow[]>([]);
  const [citiesCursor, setCitiesCursor] = useState<string | null>(null);
  const [citiesLoading, setCitiesLoading] = useState(false);
  const [citiesError, setCitiesError] = useState(false);
  const cityListRequest = useRef(0);
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
  useEffect(() => {
    if (activePanel !== "project") return;
    void loadCities();
    const changed = () => void loadCities();
    window.addEventListener("__CREATOR_CITY_CHANGED__", changed);
    return () => { cityListRequest.current++; window.removeEventListener("__CREATOR_CITY_CHANGED__", changed); };
  }, [activePanel]);
  // 未完成操作的幂等标识：结果确定前保留，响应失败时用于重试与状态查询。
  const [pendingEdit, setPendingEdit] = useState<{ projectId: string; operationId: string } | null>(null);
  const [pendingCreateId, setPendingCreateId] = useState<string | null>(null);
  // Agent 活动卡片（设计 §7.3）：经活动 Studio 转发的 MCP 预览/提交/发布/试玩请求，
  // 新在前、有界保留；UI 自己的操作直连宿主、不出现在这里。
  const [agentActivity, setAgentActivity] = useState<ReadonlyArray<{ method: string; label: string; summary: string; ok: boolean; revision?: number; at: number }>>([]);
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
  const applyProject = (next: Project, mode: "preserve" | "replace", previous: Project | null) => {
    const sameProject = previous !== null && previous.projectId === next.projectId;
    const dirty = sameProject ? dirtyRegions(previous) : null;
    const saved = savedForms(next);
    if (!sameProject || previous?.revision !== next.revision) setPublishedReleaseId(null);
    setProject(next);
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
  const refresh = useCallback(async () => {
    const [response, layoutResponse] = await Promise.all([
      creatorRequest<{ projects: ProjectRow[] }>("creator.project.list", { limit: 50 }),
      creatorRequest<{ layouts: LayoutRow[]; cityLayouts?: LayoutRow[] }>("creator.layout.list", { limit: 8 }),
    ]);
    setProjects(response.projects);
    const availableLayouts = [...layoutResponse.layouts, ...(layoutResponse.cityLayouts ?? [])];
    setLayouts(availableLayouts);
    setWorldRevision(current => availableLayouts.some(layout => layoutSelectionKey(layout) === current) ? current : availableLayouts[0] ? layoutSelectionKey(availableLayouts[0]) : "");
  }, []);
  const openCityView = async (cityId: string, revision: number) => {
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
  useEffect(() => {
    const methods = ["creator.city.create", "creator.city.create_from_world", "creator.city.diagnostic.list", "creator.city.edit.preview", "creator.city.patch.preview", "creator.city.edit.commit", "creator.city.list", "creator.city.read", "creator.layout.list", "creator.project.list", "creator.project.read", "creator.project.read_chunk", "creator.operation.status", "creator.project.create",
      "creator.game.preview", "creator.asset.import", "creator.game.commit", "creator.scene.preview", "creator.scene.commit", "creator.project.commit", "creator.project.publish",
      "creator.project.playtest.start", "creator.project.playtest.result", "creator.project.playtest.cancel", "creator.project.playtest.return_context", "creator.project.playtest.history",
      "creator.scene.describe", "creator.scene.inspect", "creator.scene.validate", "creator.capabilities.list",
      "creator.vehicle.preview", "creator.vehicle.define", "creator.vehicle.inspect",
      "creator.city.anchor.list", "creator.city.anchor.upsert", "creator.city.anchor.remove",
      "creator.mount.list", "creator.mount.bind", "creator.mount.unbind", "creator.game.bind.preview"];
    // 这些调用只能来自宿主/MCP 路由（UI 自己的请求直连宿主、不经此转发），
    // 所以这里的捕获天然就是「Agent 来源」的变更记录——设计 §7.3 的变更卡片数据源。
    const noteAgent = (method: string, payload: Record<string, unknown>, ok: boolean, result: unknown) => {
      const labels: Record<string, string> = {
        "creator.project.create": "新建项目", "creator.game.preview": "规则预览", "creator.scene.preview": "场景预览",
        "creator.game.commit": "提交规则", "creator.scene.commit": "提交场景", "creator.project.commit": "Agent 提交",
        "creator.project.publish": "发布到 City", "creator.project.playtest.start": "请求试玩",
        "creator.project.playtest.cancel": "取消试玩", "creator.asset.import": "导入模型",
        "creator.scene.capture": "视口捕获",
        "creator.vehicle.preview": "飞行器预览", "creator.vehicle.define": "定义飞行器", "creator.vehicle.inspect": "检视飞行器",
      };
      const label = labels[method];
      if (!label) return;
      let summary = "";
      if (method === "creator.scene.preview" && Array.isArray(payload.operations)) {
        const counts = new Map<string, number>();
        for (const operation of payload.operations as Array<{ op?: string }>) {
          const kind = String(operation.op ?? "unknown").split(".")[0];
          counts.set(kind, (counts.get(kind) ?? 0) + 1);
        }
        summary = [...counts.entries()].map(([kind, count]) => `${kind}×${count}`).join("、");
      } else if (typeof payload.releaseId === "string") summary = payload.releaseId;
      const revision = (result as { revision?: number } | null)?.revision;
      setAgentActivity(list => [{ method, label, summary, ok, revision, at: Date.now() }, ...list].slice(0, 6));
    };
    // P2 语义搬运（设计 §5.2）：Agent 来源的 preview 在转发前经 Studio 的 city-sdk
    // 校验并附加 validation 信封；Rust 签发时核对作用域（projectId/baseRevision/
    // payloadDigest）并原子绑定结论，commit 闸门据此放行。校验目标必须与请求的
    // projectId/baseRevision 一致（审查修复）：不是当前打开的项目时取权威文档，
    // 取不到或 revision 漂移按判负出信封。
    const attachValidation = async (method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (method === "creator.city.create") {
        const request = { name: payload.name, seed: payload.seed, profile: payload.profile, operationId: payload.operationId };
        const checked = validateCityInstance({ schemaVersion: 1, cityId: "city-validation", revision: 0,
          name: request.name, seed: request.seed, profile: request.profile });
        return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(request), ok: checked.ok } };
      }
      if (method === "creator.city.create_from_world") {
        const request = { name: payload.name, operationId: payload.operationId, packageId: payload.packageId, version: payload.version };
        let ok = false;
        try {
          const available = parseInstalledPackages(await creatorRequest<unknown>("creator.content.list", {})) ?? [];
          const item = available.find(candidate => candidate.packageId === request.packageId && candidate.version === request.version);
          if (!item) throw new Error("content_package_not_found");
          const world = await inspectInstalledWorld(creatorRequest, item);
          if (!("defaultSeed" in world.manifest.entry)) throw new Error("content_snapshot_invalid");
          const checked = validateCityInstance({ schemaVersion: 1, cityId: "city-validation", revision: 0,
            name: request.name, seed: world.manifest.entry.defaultSeed, profile: world.profile });
          const boundRequest = { ...request, contentDigest: item.contentDigest };
          ok = supportsInstalledWorldGenerator(world.manifest) && checked.ok;
          return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(boundRequest), ok } };
        } catch { /* Fail closed below with a validation bound to no usable package content. */ }
        const boundRequest = { ...request, contentDigest: null };
        return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(boundRequest), ok } };
      }
      if (method === "creator.city.edit.preview") {
        // world.set 形态（世界多样化规格 §5.2）：operations 与 name/seed 配方替换
        // 互斥（宿主同样拒绝）。语义合并以 city-sdk 为单一来源：读权威文档、按
        // 生成器落位（arid legacy 键→dunes，其余→diversity；coastal→coastal 字段），
        // 合并结果经 validateCityWorldProfile 复验；摘要绑定 profile+operations。
        // 任何失败按判负出信封（ok=false），结构侧稳定错误码（world_params_* 等）
        // 由宿主先行给出。
        if (Array.isArray(payload.operations)) {
          let fallbackProfile: unknown = {};
          let merged: CityWorldProfileV1 | null = null;
          try {
            const city = validateCityInstance(await creatorRequest<unknown>("creator.city.read", { cityId: payload.cityId }));
            if (city.ok) {
              fallbackProfile = city.value.profile;
              if (city.value.revision === payload.baseRevision) {
                merged = applyCityWorldOperations(city.value.profile, payload.operations);
              }
            }
          } catch { merged = null; }
          const request = { cityId: payload.cityId, baseRevision: payload.baseRevision,
            profile: merged ?? fallbackProfile, operations: payload.operations };
          return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(request), ok: merged !== null } };
        }
        const request = { cityId: payload.cityId, baseRevision: payload.baseRevision, name: payload.name, seed: payload.seed, profile: payload.profile };
        const checked = validateCityInstance({ schemaVersion: 1, cityId: request.cityId, revision: request.baseRevision,
          name: request.name, seed: request.seed, profile: request.profile });
        return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(request), ok: checked.ok } };
      }
      if (method === "creator.city.patch.preview") {
        const request = { cityId: payload.cityId, baseRevision: payload.baseRevision, patch: payload.patch };
        let ok = false;
        try {
          const city = validateCityInstance(await creatorRequest<unknown>("creator.city.read", { cityId: request.cityId }));
          ok = city.ok && city.value.revision === request.baseRevision && (request.patch === null || validateWorldPlanPatch(request.patch, city.value.seed, CITY_GENERATOR_VERSION).ok);
        } catch { ok = false; }
        return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(request), ok } };
      }
      // 车辆定义/预览（2026-11-15 泛化切片）：define 面发送展平字段、preview 面发送
      // `vehicle` 对象；统一归一化为完整 VehicleProfileV1（camera 缺省 = 确定性默认
      // 公式），SDK 判定后按完整 profile 出信封——宿主 scope 核对与结构硬闸都以
      // 这份载荷为准。modelAssetId 只透传（null 或项目 assetId），本面不接本地路径。
      if (method === "creator.vehicle.preview" || method === "creator.vehicle.define") {
        const outcome = normalizeVehicleProfileInput(payload.vehicle ?? payload);
        const validation = await buildVehicleValidation(String(payload.projectId ?? ""), Number(payload.baseRevision ?? 0), outcome);
        // The host dispatch accepts exactly the preview/define contract keys; the
        // flattened MCP arguments (label/physics/bounds/...) must not leak through.
        return method === "creator.vehicle.define"
          ? { projectId: payload.projectId, baseRevision: payload.baseRevision, vehicleId: payload.vehicleId,
              vehicle: outcome.vehicle, operationId: payload.operationId, validation }
          : { projectId: payload.projectId, baseRevision: payload.baseRevision, vehicle: outcome.vehicle, validation };
      }
      const projectId = String(payload.projectId ?? "");
      const baseRevision = Number(payload.baseRevision ?? 0);
      if (method === "creator.game.preview") {
        return { ...payload, validation: await buildGameValidation(projectId, baseRevision, payload.game) };
      }
      if (method === "creator.scene.preview") {
        let document: Project | null = projectRef.current?.projectId === projectId ? projectRef.current : null;
        if (!document) {
          try { document = await creatorRequest<Project>("creator.project.read", { projectId }); }
          catch { document = null; }
        }
        if (!document || document.revision !== baseRevision) {
          const message = !document ? "预览目标项目不存在或 Studio 无法读取，无法完成语义校验。"
            : `预览目标 revision ${baseRevision} 与项目当前 revision ${document.revision} 不一致，无法完成语义校验。`;
          return { ...payload, validation: scopeMismatchEnvelope(projectId, baseRevision, "creator_validation_scope_mismatch", message) };
        }
        return { ...payload, validation: await buildSceneValidation(document, projectId, baseRevision, payload.operations) };
      }
      return payload;
    };
    const handlers = Object.fromEntries(methods.map(method => [method, async (payload: Record<string, unknown>) => {
      let result: unknown;
      try {
        if (method === "creator.operation.status" && approvalGate.current.isPending(payload.projectId, payload.operationId)) {
          return { status: "awaiting_confirmation" };
        }
        if (["creator.project.commit", "creator.game.commit", "creator.scene.commit"].includes(method)) {
          const commit = approvalGate.current.request(method, payload);
          setAgentCommit(commit);
          setMessage("Agent 请求保存更改，请在 Agent 面板检查并确认。");
          setActivePanel("agent");
          throw new Error("creator_confirmation_required");
        }
        const checkedPayload = await attachValidation(method, payload);
        result = await creatorRequest(method, checkedPayload);
        if ((method === "creator.game.preview" || method === "creator.scene.preview") && result && typeof result === "object") {
          const preview = result as { previewId?: unknown; projectId?: unknown; baseRevision?: unknown; expiresInMs?: unknown; changedObjects?: unknown };
          const validation = checkedPayload.validation as { ok?: unknown } | undefined;
          if (typeof preview.previewId === "string" && typeof preview.projectId === "string" && typeof preview.baseRevision === "number"
            && typeof preview.expiresInMs === "number" && preview.expiresInMs > 0 && validation?.ok === true) {
            const operations = Array.isArray(payload.operations) ? payload.operations.length : 0;
            const details = Array.isArray(preview.changedObjects) ? preview.changedObjects.slice(0, 10).flatMap(item => {
              if (!item || typeof item !== "object") return [];
              const value = item as Record<string, unknown>;
              return typeof value.id === "string" && typeof value.action === "string" ? [`${value.action.slice(0, 32)} · ${value.id.slice(0, 128)}`] : [];
            }) : [];
            const cityOperations = Array.isArray(payload.operations) ? payload.operations.filter(item => item && typeof item === "object" && (item.op === "city.patch.upsert" || item.op === "city.patch.remove")) : [];
            const singleCityPatch = cityOperations.length === 1 && operations === 1 && cityOperations[0].op === "city.patch.upsert" ? cityOperations[0].patch : undefined;
            approvalGate.current.remember({ previewId: preview.previewId, projectId: preview.projectId, revision: preview.baseRevision,
              kind: method === "creator.game.preview" ? "game" : "scene", summary: method === "creator.game.preview" ? "玩法规则修改" : `场景修改（${operations} 项操作）`,
              details, changes: JSON.stringify(method === "creator.game.preview" ? payload.game : payload.operations, null, 2),
              requiresCityPreview: cityOperations.length > 0, ...(singleCityPatch ? { cityPatch: singleCityPatch } : {}), expiresAt: Date.now() + Math.min(preview.expiresInMs, 600_000) });
          }
        }
      } catch (error) {
        if (!(error instanceof Error && error.message === "creator_confirmation_required")) noteAgent(method, payload, false, null);
        throw error;
      }
      if (method === "creator.project.create" || method.endsWith(".commit")) window.dispatchEvent(new Event("__CREATOR_PROJECT_CHANGED__"));
      if (method === "creator.city.create" || method === "creator.city.create_from_world" || method === "creator.city.edit.commit") window.dispatchEvent(new Event("__CREATOR_CITY_CHANGED__"));
      noteAgent(method, payload, true, result);
      return result;
    }]));
    // This is a read-only Studio viewport, not a City runtime switch. It never
    // reads the legacy seed-keyed patch or writes to the active City.
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.view"] = async payload => {
      if (typeof payload.cityId !== "string" || typeof payload.revision !== "number" || !Number.isSafeInteger(payload.revision) || payload.revision < 0) throw new Error("creator_request_invalid");
      return openCityView(payload.cityId, payload.revision);
    };
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.view.status"] = async payload => {
      const current = draftCityViewRef.current;
      if (!current || current.cityId !== payload.cityId || current.revision !== payload.revision) throw new Error("creator_capture_unavailable");
      return { cityId: current.cityId, revision: current.revision, status: draftViewStatusRef.current, failureCode: draftViewFailureRef.current ?? null,
        correlationId: draftDiagnosticsRef.current?.correlationId ?? null, diagnosticsAvailable: !draftDiagnosticsRef.current?.unavailable, mode: "read_only_preview" };
    };
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.capture"] = async payload => {
      const current = draftCityViewRef.current;
      const engine = draftEngineRef.current;
      if (!current || current.cityId !== payload.cityId || current.revision !== payload.revision || draftViewStatusRef.current !== "ready" || !engine) throw new Error("creator_capture_unavailable");
      const latest = await creatorRequest<unknown>("creator.city.read", { cityId: current.cityId });
      const validated = validateCityInstance(latest);
      if (!validated.ok || validated.value.revision !== current.revision) throw new Error("revision_conflict");
      if (draftCityViewRef.current !== current || draftEngineRef.current !== engine || draftViewStatusRef.current !== "ready") throw new Error("creator_capture_unavailable");
      const frame = engine.captureFrame();
      if (!frame.ok) throw new Error(frame.code);
      const camera = engine.inspectScene().camera as { position?: number[]; target?: number[] } | null;
      return { format: "image/jpeg", dataUrl: frame.dataUrl, width: frame.width, height: frame.height, downscaled: frame.downscaled,
        bytes: Math.ceil(frame.dataUrl.length * 0.75), cityId: current.cityId, revision: current.revision,
        camera: camera ? { position: camera.position, target: camera.target } : null, capturedAtMs: Date.now() };
    };
    for (const method of ["creator.city.anchor.list", "creator.city.anchor.upsert", "creator.city.anchor.remove",
      "creator.mount.list", "creator.mount.bind", "creator.mount.unbind", "creator.game.bind.preview"]) {
      (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)[method] = async payload => creatorRequest(method, payload);
    }
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.layout.read"] = async payload => {
      const current = draftCityViewRef.current;
      const engine = draftEngineRef.current;
      if (!current || current.cityId !== payload.cityId || current.revision !== payload.revision || draftViewStatusRef.current !== "ready" || !engine) throw new Error("creator_capture_unavailable");
      const latest = validateCityInstance(await creatorRequest<unknown>("creator.city.read", { cityId: current.cityId }));
      if (!latest.ok || latest.value.revision !== current.revision) throw new Error("revision_conflict");
      if (draftCityViewRef.current !== current || draftEngineRef.current !== engine || draftViewStatusRef.current !== "ready") throw new Error("creator_capture_unavailable");
      const view = engine.getCitySdkLayoutView();
      if (!view) throw new Error("creator_layout_not_ready");
      const snapshot = createCreatorLayoutSnapshot(view);
      const scoped = validateCityLayoutScope({ ...snapshot, schemaVersion: 2, cityId: current.cityId, cityRevision: current.revision }, current);
      if (!scoped.ok) throw new Error("creator_layout_scope_invalid");
      return scoped.value;
    };
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.layout.save"] = async payload => {
      // Capture from the live, scoped renderer; callers cannot supply a snapshot.
      const current = draftCityViewRef.current;
      try {
        const snapshot = await (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.layout.read"](payload);
        const result = await creatorRequest("creator.city.layout.store", { snapshot });
        if (current) await recordCityDiagnostic(current, "layout_saved");
        window.dispatchEvent(new Event("__CREATOR_LAYOUT_CHANGED__"));
        return result;
      } catch (error) {
        if (current) await recordCityDiagnostic(current, "layout_save_failed", "layout_store_failed");
        throw error;
      }
    };
    // creator.scene.capture 在 WebView 本地完成（渲染器在这里，图像不出本机）；
    // describe/capabilities 走上面的转发、由 Rust 权威分发。projectRef 拿当前 revision。
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.scene.capture"] = async (payload: Record<string, unknown>) => {
      if (draftCityViewRef.current) throw new Error("creator_capture_unavailable");
      const engine = studioEngineRef.current;
      if (!engine) throw new Error("creator_capture_unavailable");
      // 契约要求捕获绑定捕获时的 revision：没有打开的项目就没有可绑定的 revision
      if (!projectRef.current) throw new Error("creator_capture_requires_project");
      if (typeof payload.revision === "number" && payload.revision !== projectRef.current.revision) throw new Error("revision_conflict");
      // 帧按描述符给 capture 的 mailbox 预算（512 KiB）与 MCP 帧上限（350K 字符）
      // 逐档降级；不可用与超预算由 captureFrame 返回不同 code，不能混成一句。
      const frame = engine.captureFrame();
      if (!frame.ok) throw new Error(frame.code);
      const camera = engine.inspectScene().camera as { position?: number[]; target?: number[] } | null;
      const result = { format: "image/jpeg", dataUrl: frame.dataUrl, width: frame.width, height: frame.height, downscaled: frame.downscaled,
        bytes: Math.ceil(frame.dataUrl.length * 0.75), revision: projectRef.current.revision,
        camera: camera ? { position: camera.position, target: camera.target } : null, capturedAtMs: Date.now() };
      noteAgent("creator.scene.capture", payload, true, { revision: projectRef.current.revision });
      return result;
    };
    // creator.scene.validate 由 Studio 合并三方结果（设计 §5.3）：Rust structure_check
    // 提供结构/预算/资产字节事实，SDK 提供 game/scene/mount 语义诊断，这里合并、
    // 去重（code+objectId）、排序并截断。MCP 工具表不暴露 structure_check。
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.scene.validate"] = async (payload: Record<string, unknown>) => {
      const profile = payload.validationProfile;
      if (profile !== undefined && profile !== "static") throw new Error("creator_validation_profile_unsupported");
      const document = await creatorRequest<Project>("creator.project.read", { projectId: String(payload.projectId ?? "") });
      if (typeof payload.revision === "number" && payload.revision !== document.revision) throw new Error("revision_conflict");
      const structure = await creatorRequest<{ ok: boolean; truncated: boolean; items: Array<Record<string, unknown>>; unchecked: unknown[] }>(
        "creator.scene.structure_check", { projectId: document.projectId, revision: document.revision });
      const sdkItems: Array<Record<string, unknown>> = [];
      const pushSdk = (diagnostics: readonly { code: string; severity: "error" | "warning"; path: string; objectId?: string; message: string }[]) => {
        for (const item of diagnostics) {
          sdkItems.push({ code: item.code, severity: item.severity, source: "static-schema",
            objectId: item.objectId ?? null, message: item.message });
        }
      };
      pushSdk(validateMiniGamePack(document.game).diagnostics);
      if (document.scene) pushSdk(validateSceneDraft(document.scene).diagnostics);
      const layout = document.cityLayout && !Array.isArray(document.cityLayout) ? (document.cityLayout as { layout?: unknown }).layout : undefined;
      for (const mount of document.mounts ?? []) {
        if (!layout) { sdkItems.push({ code: "creator_layout_not_bound", severity: "error", source: "static-schema", objectId: mount.mountId ?? null, message: "项目未绑定 City 布局，挂载无法校验。" }); continue; }
        pushSdk(validateMount({ layout, game: document.game, mount }).diagnostics);
      }
      // 合并去重（code+objectId 同一违例只报一次），error 优先、其余稳定排序，超限截断。
      const merged = new Map<string, Record<string, unknown>>();
      for (const entry of [...structure.items, ...sdkItems]) {
        const key = `${entry.code}|${entry.objectId ?? ""}`;
        if (!merged.has(key)) merged.set(key, entry);
      }
      const MAX_ITEMS = 100;
      const ordered = [...merged.values()].sort((a, b) => (a.severity === b.severity ? String(a.code).localeCompare(String(b.code)) : a.severity === "error" ? -1 : 1));
      const truncated = structure.truncated || ordered.length > MAX_ITEMS;
      const items = ordered.slice(0, MAX_ITEMS);
      const ok = !truncated && !items.some(entry => entry.severity === "error");
      return { projectId: document.projectId, revision: document.revision, ok, truncated, items, unchecked: structure.unchecked };
    };
    const disconnectHostCalls = connectHostCalls(handlers);
    const disconnectHealth = observeHealth();
    return () => { disconnectHostCalls(); disconnectHealth(); };
  }, []);
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
      .catch(error => { if (!cancelled) setMessage(errorCode(error, "creator_load_failed")); });
    return () => { cancelled = true; };
  }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    void loadStudioAtStartup(async () => {
      const context = await creatorRequest<{ runId: string; projectId: string; revision: number; status: "completed" | "cancelled" | "failed";
      evidence?: { tick: number; counters: Record<string, number>; outcome: "success" | "failure" | null } | null; failureCode?: string | null } | null>("creator.project.playtest.return_context", {});
      if (!cancelled && context) {
        const counters = context.evidence ? Object.entries(context.evidence.counters).map(([key, value]) => `${key}=${value}`).join(", ") : "";
        const result = context.evidence ? ` · tick ${context.evidence.tick} · ${context.evidence.outcome ?? "未完成"}${counters ? ` · ${counters}` : ""}` : context.failureCode ? ` · ${context.failureCode}` : "";
        const message = `City 试玩已返回：${context.status} · revision ${context.revision}${result} · ${context.runId}`;
        // PRD：试玩结束回到同一编辑上下文——保留未提交草稿，并回到全局视角。
        void openProject(context.projectId, "preserve").then(() => { setFocusSignal(value => value + 1); setMessage(message); });
      }
    }, { isCancelled: () => cancelled, delay: ms => new Promise(resolve => window.setTimeout(resolve, ms)) }).catch(error => {
        const code = errorCode(error, "creator_playtest_return_failed");
        if (!cancelled && code !== "creator_playtest_not_found") setMessage(code);
      });
    return () => { cancelled = true; };
  }, []);

  const openProject = async (projectId: string, mode: "replace" | "preserve" = "replace") => {
    setInstalledWorldView(null);
    setBusy(true); setMessage(""); setPreviewId(null); setPreviewKind(null); setPublishedReleaseId(null);
    try {
      const next = await creatorRequest<Project>("creator.project.read", { projectId });
      applyProject(next, mode, project);
      cityOpenRequest.current++; draftCityViewRef.current = null; setDraftCityView(null);
      setFocusSignal(value => value + 1);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_read_failed"); }
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
      await refresh(); await openProject(created.projectId); setActivePanel("play");
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
        entryAnchorId, bindings, parameterOverrides: {},
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
      const release = await creatorRequest<{ releaseId: string; revision: number }>("creator.project.publish", {
        projectId: project.projectId, expectedRevision: project.revision,
      });
      setPublishedReleaseId(release.releaseId);
      setMessage(`已发布到我的 City：revision ${release.revision}（${release.releaseId}）。此版本固定，不会随草稿修改。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_publish_failed"); }
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
    if (!city || busy || browserPreview) return;
    setBusy(true); setMessage("");
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
      if (code !== "creator_export_cancelled") setMessage(`城市源码导出失败（${code}）。请检查城市版本和编辑内容。`);
    } finally { setBusy(false); }
  };

  const exportSource = async () => {
    if (!project || !projectCity?.city || projectCity.key !== projectCityKey || hasUncommittedProjectEdits || busy) return;
    setBusy(true); setMessage("");
    try {
      const source = await buildProjectSourceExport(project, projectCity.city, CITY_GENERATOR_VERSION);
      const result = await creatorRequest<{ directoryName: string; assetCount: number }>("creator.source.export", {
        projectId: project.projectId, revision: project.revision, ...source,
      });
      if (!/^city-source-[a-f0-9]+$/.test(result.directoryName) || !Number.isSafeInteger(result.assetCount)) throw new Error("creator_export_invalid");
      setMessage(`源码已导出至所选目录中的 ${result.directoryName}；${project.mounts.length ? "游戏布局为当前城市快照，换城市须重新绑定。" : "游戏尚未绑定场地，配置挂载后才能验证和试玩。"}`);
    } catch (error) {
      const code = errorCode(error, "creator_export_failed");
      if (code !== "creator_export_cancelled") setMessage(`源码导出失败（${code}）。请检查项目版本、城市绑定及资产。`);
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
      if (value === "more") { setActivePanel("project"); return; }
      const row = toolbarProjects[Number(value)];
      if (row && row.projectId !== project?.projectId) guardDrafts(row.projectId, () => void openProject(row.projectId));
    } else if (commandId === "creator.playtest" && !busy && publishedReleaseId && !hasUncommittedProjectEdits) void startPlaytest();
    else if (commandId === "creator.publish" && !busy && project && !hasUncommittedProjectEdits && project.mounts?.length) void publish();
  };
  useEffect(() => connect(command => toolbarActionRef.current(command.commandId, command.value)), []);
  useEffect(() => {
    const selected = toolbarProjects.findIndex(row => row.projectId === project?.projectId);
    publishToolbar([
      { id: "project", commandId: "creator.project", label: "选择城市项目", kind: "select", enabled: !busy,
        value: selected < 0 ? "more" : String(selected), options: [
          ...toolbarProjects.map((row, index) => ({ value: String(index), label: `${row.title} · 版本 ${row.revision}`.slice(0, 100) })),
          { value: "more", label: project ? "更多项目…" : "选择城市项目…" },
        ] },
      { id: "playtest", commandId: "creator.playtest", label: "试玩", kind: "button", enabled: !browserPreview && !busy && !!publishedReleaseId && !hasUncommittedProjectEdits },
      { id: "publish", commandId: "creator.publish", label: "发布", kind: "button", enabled: !busy && !!project && !hasUncommittedProjectEdits && !!project.mounts?.length },
    ]);
  }, [projects, project, busy, publishedReleaseId, hasUncommittedProjectEdits]);

  return <main className="studio">
    <div className="workspace">
      <nav className="studio-rail" aria-label="创作模式">
        <button className={activePanel === "project" ? "active" : ""} aria-pressed={activePanel === "project"} onClick={() => setActivePanel("project")}><span aria-hidden="true">▤</span>项目</button>
        <button className={activePanel === "play" ? "active" : ""} aria-pressed={activePanel === "play"} onClick={() => setActivePanel("play")}><span aria-hidden="true">◇</span>玩法</button>
        <button className={activePanel === "agent" ? "active" : ""} aria-pressed={activePanel === "agent"} onClick={() => setActivePanel("agent")}><span aria-hidden="true">✦</span>Agent</button>
      </nav>
      <section className="viewport" aria-label="City 实时视口">
        <div className="viewport-head"><div className="section-title">城市视图</div><span className="viewport-hint">点选建筑移动 · 拖动旋转 · 滚轮缩放</span><button className="secondary reset-view" onClick={() => setFocusSignal(value => value + 1)}>重置视角</button></div>
        <div className="viewport-base">{installedWorldView && "defaultSeed" in installedWorldView.manifest.entry ? <div className="viewport-frame"><CityViewport key={draftCityView ? `${draftCityView.cityId}:${draftCityView.revision}:${installedWorldView.manifest.contentDigest}` : installedWorldView.manifest.contentDigest} seed={installedWorldView.manifest.entry.defaultSeed} worldProfile={installedWorldView.profile} isolatedDraft isolatedProjectPatch={installedWorldView.patch as PlanPatchV1 | null} worldScene={installedWorldView} registerProbe={false} onEngineChange={engine => { if (draftCityView && draftCityViewRef.current === draftCityView) draftEngineRef.current = engine; }} onViewportStatus={(status, code) => {
          if (draftCityView) {
            draftViewStatusRef.current = status; draftViewFailureRef.current = code;
            void recordCityDiagnostic(draftCityView, status === "ready" ? "view_ready" : status === "failed" ? "view_failed" : "view_started", code);
            if (status === "ready") setMessage(`独立城市 ${draftCityView.name} 的固定世界包场景已加载；场景碰撞和玩法尚未启用。`);
            else if (status === "failed") setMessage(`独立城市世界包预览失败（${code ?? "content_preview_failed"}）。`);
          } else if (status === "ready") setMessage("世界包只读预览已加载；场景碰撞和玩法尚未启用。");
          else if (status === "failed") setMessage(`世界包预览失败（${code ?? "content_preview_failed"}）。`);
        }} /><div className="viewport-savebar" role="status">{draftCityView ? `独立城市 ${draftCityView.name} · 固定世界包 · 只读预览` : "世界包只读预览"} · 场景碰撞和玩法未启用 <button onClick={() => setInstalledWorldView(null)}>返回项目视图</button></div></div> : draftCityView ? <div className="viewport-frame"><CityViewport key={`${draftCityView.cityId}:${draftCityView.revision}`} seed={draftCityView.seed} worldProfile={draftCityView.profile} isolatedDraft isolatedProjectPatch={(draftCityView.planPatch ?? null) as PlanPatchV1 | null} focusSignal={focusSignal}
          onEngineChange={engine => { if (draftCityViewRef.current === draftCityView) draftEngineRef.current = engine; }}
          onViewportStatus={(status, code) => { if (draftCityViewRef.current === draftCityView) {
            draftViewStatusRef.current = status; draftViewFailureRef.current = code;
            if (status === "ready") { void recordCityDiagnostic(draftCityView, "view_ready"); setMessage(`独立城市 ${draftCityView.name}（版本 ${draftCityView.revision}）已加载，可进行只读预览。`); }
            else if (status === "failed") {
              const safeCode = code?.includes("planning-outcome-failed") ? "planning_outcome_failed" : code?.startsWith("engine_initialization_failed") ? "engine_initialization_failed" : "layout_preparation_failed";
              void recordCityDiagnostic(draftCityView, "view_failed", safeCode); setMessage(`独立城市预览加载失败${code ? `（${code}）` : ""}。`);
            }
          } }} />
          <div className="viewport-savebar" role="status">独立城市只读预览 · {draftCityView.name} · 版本 {draftCityView.revision} <button disabled={busy || browserPreview} onClick={() => void exportCitySource()}>导出城市源码…</button> <button onClick={() => { cityOpenRequest.current++; draftCityViewRef.current = null; setDraftCityView(null); }}>返回项目视图</button></div></div>
          : projectCityKey ? (projectCity?.key !== projectCityKey
            ? <div className="empty viewport-empty">正在读取项目绑定的城市…</div>
            : projectCity.city && isolatedPatchResult && !isolatedPatchResult.ok ? <div className="empty viewport-empty">城市编辑补丁无效或与当前生成器不兼容，无法安全预览。</div>
            : projectCity.city ? <div className="viewport-frame"><CityViewport key={`${projectCityKey}:${projectCity.worldScene?.manifest.contentDigest ?? "generated"}`} seed={projectCity.city.seed} worldProfile={projectCity.city.profile} isolatedDraft isolatedProjectPatch={projectCity.worldScene?.patch as PlanPatchV1 | null ?? (isolatedPatchResult?.ok ? isolatedPatchResult.value as unknown as PlanPatchV1 : null)} worldScene={projectCity.worldScene} focusSignal={focusSignal} onEngineChange={setBaseEngine} onViewportStatus={setBaseStatus} />
              <div className="viewport-savebar" role="status">独立城市只读预览{projectCity.worldScene ? " · 已恢复固定世界包场景" : ""}{projectCity.error ? ` · 世界包场景不可用（${projectCity.error}）` : ""} · 城市编辑尚不可用</div></div>
            : <div className="empty viewport-empty">{projectCity.error}</div>)
          : viewportSeed !== null
          ? <div className="viewport-frame"><CityViewport seed={viewportSeed} worldProfile={worldProfile} editable={!!project} focusSignal={focusSignal}
              projectPatch={(project?.cityPatch ?? null) as PlanPatchV1 | null} onPatchCommit={patch => commitPatchRef.current(patch)}
              onEngineChange={setBaseEngine} onViewportStatus={setBaseStatus} />{!project && <div className="viewport-welcome"><div className="welcome-card"><span className="welcome-kicker">YOUR CITY, YOUR IDEAS</span><h2>从一座城市开始创作</h2><p>打开已有项目，或选择一个玩法模板创建新项目。</p><button onClick={() => setActivePanel("project")}>创建城市项目</button></div></div>}</div>
          : <div className="empty viewport-empty">{viewportUnavailable
            ? "当前项目没有绑定的 City 布局快照，视口无法恢复它编辑的城市。请在 City 中重新生成道路地图后新建项目。"
            : "先打开 City 生成道路地图，这里会显示同一座实时城市。"}</div>}</div>
        {agentCityPreview && <div className="viewport-frame viewport-agent-preview"><CityViewport key={agentCommit!.previewId} seed={agentCityPreview.seed} worldProfile={agentCityPreview.profile} isolatedDraft={agentCityPreview.isolated} previewPatch={agentCityPreview.patch} registerProbe={false} focusSignal={focusSignal}
          onViewportStatus={(status, code) => setAgentPreviewStatus(previous => previous?.context === agentCityPreview && previous.status === status && previous.code === code ? previous : { context: agentCityPreview, status, code })} />
          <div className="viewport-savebar" role="status">Agent 临时预览 · 不会保存到城市</div></div>}
      </section>
      <aside className="panel" aria-label="创作检查器">
        <div className="inspector-heading"><div><span className="sidebar-kicker">INSPECTOR</span><h2>{activePanel === "agent" ? "City Agent" : activePanel === "project" ? "城市项目" : "玩法与场地"}</h2></div>{project && <span className="version-pill">版本 {project.revision}</span>}</div>
        <nav className="inspector-tabs" aria-label="工作台面板"><button className={activePanel === "play" ? "active" : ""} aria-pressed={activePanel === "play"} onClick={() => setActivePanel("play")}>玩法</button><button className={activePanel === "agent" ? "active" : ""} aria-pressed={activePanel === "agent"} onClick={() => setActivePanel("agent")}>Agent</button><button className={activePanel === "project" ? "active" : ""} aria-pressed={activePanel === "project"} onClick={() => setActivePanel("project")}>项目</button></nav>
        {message && <p className="status status-banner" role="status">{message}</p>}
        <p className="readiness">{browserPreview ? "合成数据预览 · " : ""}{releaseHint}</p>
        {activePanel === "agent" && <section className="agent-panel" aria-label="City Agent">
          {agentCommit && <div className="agent-card" role="group" aria-label="等待确认的 Agent 修改"><div className="agent-card-head"><span className="agent-label">等待确认</span><span className="agent-time">版本 {agentCommit.expectedRevision}</span></div>
            <p>{agentCommit.proposal.summary}</p>{agentCommit.proposal.details.length > 0 && <ul>{agentCommit.proposal.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}<details><summary>查看完整修改内容</summary><pre className="agent-proposal-content">{agentCommit.proposal.changes}</pre></details><p className="muted">项目 {agentCommit.projectId}。{agentCommit.proposal.requiresCityPreview ? !agentCityPreview ? "无法显示该城市修改：请打开对应项目、等待基准布局就绪，并将单个城市补丁单独预览。" : agentPreviewStatus?.context !== agentCityPreview || agentPreviewStatus.status === "loading" ? "正在准备三维临时预览。" : agentPreviewStatus.status === "failed" ? "预览失败或包含失效项，不能保存。" : "基准路网已匹配，三维临时预览已显示；确认后才会保存。" : "此修改尚未提供三维预览，确认后才会保存。"}</p>
            <div className="actions"><button disabled={busy || (agentCommit.proposal.requiresCityPreview && (!agentCityPreview || agentPreviewStatus?.context !== agentCityPreview || agentPreviewStatus.status !== "ready"))} onClick={() => void resolveAgentCommit(true)}>确认保存</button><button className="secondary" disabled={busy} onClick={() => void resolveAgentCommit(false)}>取消</button></div></div>}
          {agentActivity.length > 0 ? <div className="agent-activity">{agentActivity.map(item => <div key={item.at} className={`agent-card ${item.ok ? "" : "failed"}`}>
            <div className="agent-card-head"><span className="agent-label">{item.label}</span><span className="agent-time">{new Date(item.at).toLocaleTimeString()}</span></div>
            {item.summary && <p className="agent-summary">{item.summary}</p>}
            <p className="muted">{item.ok ? `已受理${item.revision !== undefined ? ` · revision ${item.revision}` : ""}` : "请求失败（错误码见状态区）"}</p>
          </div>)}</div>
          : <div className="agent-empty">
            <div className="agent-empty-icon" aria-hidden="true">✦</div><strong>等待 Agent 操作</strong><p>通过外部 Agent 连接 Studio 后，项目操作会显示在这里。</p>
          </div>}
        </section>}
        {activePanel === "project" && <section className="new-project">
          <div><div className="section-title">独立城市</div><p className="muted">打开已保存的城市进行只读预览，或导出城市源码；不会切换玩家的当前 City。</p>
            <div className="project-list">{cities.map(city => <button key={city.cityId} className={`project-row ${draftCityView?.cityId === city.cityId ? "selected" : ""}`} disabled={busy || citiesLoading} onClick={() => {
              setBusy(true); void openCityView(city.cityId, city.revision).catch(error => { const code = errorCode(error, "creator_city_view_failed"); setMessage(code === "revision_conflict" ? "城市版本已变化，请刷新列表后重新打开。" : `无法打开城市（${code}）。`); void loadCities(); }).finally(() => setBusy(false));
            }}><strong>{city.name}</strong><span>版本 {city.revision}{draftCityView?.cityId === city.cityId ? " · 预览中" : ""}</span></button>)}</div>
            {citiesLoading && <p className="muted">正在读取城市…</p>}
            {citiesError && <p className="muted">城市列表读取失败，请重试。</p>}
            {!citiesLoading && !citiesError && cities.length === 0 && <p className="muted">还没有独立城市。</p>}
            <div className="actions"><button className="secondary" disabled={citiesLoading || busy} onClick={() => void loadCities()}>刷新城市列表</button>{citiesCursor && <button className="secondary" disabled={citiesLoading || busy} onClick={() => void loadCities(citiesCursor)}>加载更多</button>}</div>
          </div>
          <div><div className="section-title">导出源码项目</div><p className="muted">导出已保存的独立城市和小游戏；未绑定的游戏需配置场地后才能试玩。导出不包含用户会话或试玩结果。</p>
            <button className="secondary" disabled={browserPreview || busy || !project || !projectCity?.city || projectCity.key !== projectCityKey || hasUncommittedProjectEdits || project.mounts.length > 1} onClick={() => void exportSource()}>导出源码目录…</button></div>
          <div><div className="section-title">世界内容包预检</div><p className="muted">通过桌面原生选择器打开 unsigned 的 v2 世界包，核对清单、文件集合与摘要；校验后可显式安装到本机内容库。文件路径和字节不会传入 Agent/MCP。</p>
          <button className="secondary" disabled={busy || browserPreview} onClick={() => void inspectWorldPackage()}>选择并预检世界包…</button>
          {browserPreview && <p className="muted">浏览器预览没有原生文件选择器，请在桌面应用中使用。</p>}
          {packageInspection && <code>{formatWorldPackageInspection(packageInspection)}</code>}
          {packageInspection && <div className="actions"><button disabled={busy} onClick={() => void installInspectedPackage()}>安装到本机内容库</button><span className="muted">仅本机存储，尚不可运行</span></div>}
          {installedPackages.length > 0 && <div><div className="section-title">已安装内容包</div>{installedPackages.map(item => <div key={`${item.packageId}:${item.version}`} className="actions"><code>{formatInstalledPackage(item)}</code><button className="secondary" disabled={busy} onClick={() => void validateInstalledPackage(item)}>检查内容</button><button className="secondary" disabled={busy} onClick={() => void previewInstalledPackage(item)}>只读预览</button><button disabled={busy} onClick={() => void createCityFromInstalledWorld(item)}>创建独立 City</button><button className="secondary" disabled={busy} onClick={() => { const key = `${item.packageId}:${item.version}`; if (confirmUninstall === key) void uninstallInstalledPackage(item); else setConfirmUninstall(key); }}>{confirmUninstall === `${item.packageId}:${item.version}` ? "确认卸载" : "卸载"}</button></div>)}</div>}</div>
          <div className="section-title">打开项目</div>
          <div className="project-list">{projects.map(row => <button key={row.projectId} className={`project-row ${project?.projectId === row.projectId ? "selected" : ""}`} disabled={busy} onClick={() => { if (row.projectId !== project?.projectId) guardDrafts(row.projectId, () => void openProject(row.projectId)); else { setInstalledWorldView(null); if (draftCityView) { cityOpenRequest.current++; draftCityViewRef.current = null; setDraftCityView(null); } } }}><strong>{row.title}</strong><span>版本 {row.revision}{project?.projectId === row.projectId ? " · 当前项目" : switchConfirm === row.projectId ? " · 再次点击以丢弃草稿" : ""}</span></button>)}</div>
          <div><div className="section-title">创建新项目</div><p className="muted">选择玩法和 City 布局，创建独立的本地草稿。</p></div>
          <label>新建模板<select value={template} disabled={busy} onChange={event => setTemplate(event.target.value)}><option value="checkpoint-race">驾驶检查点竞速</option><option value="collect-one">驾驶区域收集</option><option value="ornithopter-flight">扑翼飞行检查点</option></select></label>
          <label>绑定 City 世界<select value={worldRevision} disabled={busy || layouts.length === 0} onChange={event => setWorldRevision(event.target.value)}>{layouts.map(layout => <option key={layoutSelectionKey(layout)} value={layoutSelectionKey(layout)}>{layout.cityId ? `${layout.cityId} · ` : "Miami · "}{layout.layoutId} · seed {layout.seed} · {layout.anchorCount} 个锚点</option>)}</select></label>
          <button disabled={busy || !worldRevision} onClick={() => guardDrafts("create", () => void createProject())}>{switchConfirm === "create" ? "确认丢弃草稿并新建" : "新建项目"}</button>
          {layouts.length === 0 && <p className="muted">尚无 City 布局快照。先打开 City 生成道路地图，再回到 Studio。</p>}
        </section>}
        {activePanel === "play" && <section className="editor">
        <div className="section-title">{project ? "玩法与场地" : "选择一个项目"}</div>
        {project ? <>
          <p className="muted">先设置玩法场地，再校验并保存。需要修改规则时可打开高级编辑。</p>
          <details className="advanced-editor"><summary>高级：编辑玩法规则 JSON</summary>
          <textarea aria-label="Mini-game JSON" spellCheck={false} value={text} disabled={busy} onChange={event => { setText(event.target.value); setPreviewId(null); setPreviewKind(null); }} />
          <div className="actions"><button className="secondary" disabled={busy} onClick={() => void preview()}>校验规则</button><button disabled={busy || !previewId || previewKind !== "game"} onClick={() => void commit()}>保存规则</button></div>
          </details>
          <details className="scene-editor" open>
            <summary>场地与场景设置</summary>
              <p className="muted">挂载绑定到项目创建时由 City 道路适配器捕获的布局版本。快照只含稳定锚点 ID，不携带几何；世界版本变化后试玩会拒绝启动。</p>
            <details className="advanced-editor"><summary>高级：编辑场景 JSON 和模型</summary><textarea aria-label="Scene draft JSON" spellCheck={false} value={sceneText} disabled={busy} onChange={event => { setSceneText(event.target.value); setPreviewId(null); setPreviewKind(null); }} />
            <section className="composition">
              <div className="section-title">模型资源</div>
              <p className="muted">GLB 文件通过桌面原生选择器导入并存入本机项目目录。文件路径和二进制内容不会传给 Agent/MCP。已发布版本可在 City 试玩中渲染受限的静态模型；模型实例与显式碰撞代理分别配置。</p>
              <div className="actions"><button className="secondary" disabled={busy || hasUncommittedProjectEdits} onClick={() => void importModel()}>从本机导入 GLB 并放入场景</button></div>
              {project.assets?.entries.map(asset => <code key={asset.assetId}>{asset.assetId} · {Math.ceil(asset.byteLength / 1024)} KiB · {asset.boundsMeters ? `${asset.boundsMeters.x.toFixed(1)}×${asset.boundsMeters.y.toFixed(1)}×${asset.boundsMeters.z.toFixed(1)} m` : "尺寸未知"}</code>)}
            </section>
            <div className="actions"><button className="secondary" disabled={busy} onClick={() => void previewScene()}>校验场景并预览</button><button disabled={busy || !previewId || previewKind !== "scene"} onClick={() => void commit()}>保存场景</button></div></details>
            <section className="composition">
              <div className="section-title">玩法场地</div><p className="muted">选择入口与玩法目标，再校验并保存场地。</p>
              <div className="anchor-catalog"><span className="muted">可用 City 锚点</span>{project.cityLayout?.layout.anchors.map(anchor => <code key={anchor.id}>{anchor.id} · {anchor.kind}</code>)}</div>
              <label>入口锚点<select value={entryAnchorId} disabled={busy || !project.cityLayout} onChange={event => { setEntryAnchorId(event.target.value); setPreviewId(null); }}>{project.cityLayout?.layout.anchors.filter(anchor => anchor.kind === "spawn" && anchor.capabilities.includes("drive")).map(anchor => <option key={anchor.id} value={anchor.id}>{anchor.id}</option>)}</select></label>
              {visualSlot && <fieldset className="anchor-picker"><legend>{visualSlot === "points" ? "检查点" : "收集目标"}</legend><p className="muted">按点击顺序添加；再次点击可移除。{slotMinimum > 0 ? ` 此玩法至少需要 ${slotMinimum} 个。` : ""}</p>{slotMinimum > (project.cityLayout?.layout.anchors.filter(anchor => anchor.kind === "zone" && anchor.capabilities.includes("drive")).length ?? 0) && <p className="anchor-warning">当前布局可用目标不足，请返回 City 调整道路布局后重新创建项目。</p>}{project.cityLayout?.layout.anchors.filter(anchor => anchor.kind === "zone" && anchor.capabilities.includes("drive")).map(anchor => {
                let selected: string[] = []; try { const parsed = JSON.parse(bindingsText); if (Array.isArray(parsed[visualSlot])) selected = parsed[visualSlot]; } catch { /* 保留无效的高级输入 */ }
                const order = selected.indexOf(anchor.id);
                return <button type="button" className={`anchor-option ${order >= 0 ? "selected" : ""}`} aria-pressed={order >= 0} key={anchor.id} disabled={busy} onClick={() => { try { const parsed = JSON.parse(bindingsText); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return; const points = Array.isArray(parsed[visualSlot]) ? parsed[visualSlot].filter((id: unknown) => typeof id === "string") : []; setBindingsText(JSON.stringify({ ...parsed, [visualSlot]: order >= 0 ? points.filter((id: string) => id !== anchor.id) : [...points, anchor.id] }, null, 2)); setPreviewId(null); setPreviewKind(null); } catch { setMessage("请先修正高级绑定中的 JSON 格式。"); } }}><span>{order >= 0 ? `${order + 1}` : "+"}</span>{anchor.id}</button>;
              })}</fieldset>}
              <details className="advanced-editor"><summary>高级：编辑槽位绑定 JSON</summary><label>槽位绑定 JSON<textarea className="bindings" aria-label="Mount slot bindings JSON" spellCheck={false} value={bindingsText} disabled={busy} onChange={event => { setBindingsText(event.target.value); setPreviewId(null); }} /></label>
              <p className="muted">按游戏 slots 填入上方 City 锚点 ID，例如 {`{"points":["road-checkpoint:a","road-checkpoint:b"]}`}。SDK 与 Rust 都会校验槽位类型、能力和布局版本。</p></details>
              <div className="actions"><button className="secondary" disabled={busy} onClick={() => void previewMount()}>校验场地</button><button disabled={busy || !previewId || previewKind !== "mount"} onClick={() => void commit()}>保存场地</button></div>
            </section>
            <section className="composition">
              <div className="section-title">City 视觉皮肤</div>
              <label>官方皮肤<select value={skinId} disabled={busy} onChange={event => { setSkinId(event.target.value); setPreviewId(null); }}><option value="miami-vice">迈阿密霓虹</option><option value="desert-evening">沙漠暮色</option></select></label>
              <div className="actions"><button className="secondary" disabled={busy} onClick={() => void previewSkin(skinId)}>预览皮肤选择</button><button disabled={busy || !previewId || previewKind !== "skin"} onClick={() => void commit()}>保存皮肤</button></div>
            </section>
          <p className="muted">试玩会临时应用发布版本的官方 City 皮肤，结束后恢复你的 City 外观与偏好。</p>
          </details>
        </> : <div className="empty inspector-empty"><p>从项目列表或顶部选择器打开城市项目，开始编辑玩法。</p><button onClick={() => setActivePanel("project")}>创建项目</button></div>}
        </section>}
      </aside>
    </div>
    <footer className="studio-status" role="status"><span>{!project ? "未选择项目" : hasUncommittedProjectEdits ? "有未保存修改" : `项目版本 ${project.revision}`}</span><span>{browserPreview ? "合成数据预览" : releaseHint}</span></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
