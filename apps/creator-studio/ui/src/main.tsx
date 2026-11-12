import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectHostCalls, invokeHost, observeHealth, publishToolbar } from "@agent-vitals/app-sdk/ui-host";
import { canonicalJson, validateCityLayoutSnapshot, validateMiniGamePack, validateMount, type CityGameMountV1, type CityLayoutSnapshotV1 } from "@agent-vitals/city-sdk";
// 视口与 City 插件共享同一份引擎与装配管线，保证 Studio 看到的是同一座城市。
import { CityViewport } from "../../../agent-city/ui/src/viewport/CityViewport";
import { readCityAppearancePreference } from "../../../agent-city/ui/src/engine/cityWorldProfile";
import type { CityEngine } from "../../../agent-city/ui/src/engine/CityEngine";
import type { PlanPatchV1 } from "../../../agent-city/ui/src/engine/planPatch";
import "./style.css";

type ProjectRow = { projectId: string; revision: number; title: string; updatedAtMs: number };
type LayoutRow = { worldRevision: string; layoutId: string; seed: number; anchorCount: number; updatedAtMs: number };
type SceneDraft = { schemaVersion: 1; objects: Array<Record<string, unknown>> };
// 试玩历史行（creator.project.playtest.history 返回的 runs 元素），状态沿用后端英文枚举不翻译。
type PlaytestRun = { runId: string; releaseId: string; revision: number; status: "pending" | "claimed" | "completed" | "cancelled" | "failed" | "expired"; createdAtMs: number; finishedAtMs: number | null; evidenceSource: string | null; evidence: unknown; failureCode: string | null };
type Project = { projectId: string; revision: number; title?: string; kind: string; game: unknown; cityLayout?: CityLayoutSnapshotV1 | null; cityPatch?: Record<string, unknown> | null; scene?: SceneDraft; assets?: { schemaVersion: 1; entries: Array<{ assetId: string; relativePath: string; sha256: string; byteLength: number; format: "glb-v2"; boundsMeters?: { x: number; y: number; z: number } }> }; assetRefs?: Array<Record<string, unknown>>; mounts: CityGameMountV1[]; skinId?: string };
type PluginResponse<T> = { version: number; requestId: string; ok: boolean; result?: T; error?: { code: string } };
let sequence = 0;
// 浏览器预览（ui-dev 工作台 iframe）：有插件实例但没有原生宿主，数据来自合成夹具。
const browserPreview = typeof window !== "undefined" && window.parent !== window
  && !(window as Window & { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core?.invoke;

function errorCode(error: unknown, fallback: string): string {
  const candidate = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^[a-z][a-z0-9_]{0,63}$/.test(candidate) ? candidate : fallback;
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
  const response = await invokeHost<PluginResponse<T>>("plugin_request", { request: { version: 1, instanceId, requestId, method, payload } });
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
    project?.cityLayout?.seed ?? (worldRevision ? layouts.find(layout => layout.worldRevision === worldRevision)?.seed ?? null : null);
  const viewportUnavailable = project !== null && !project.cityLayout;
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<"game" | "scene" | "mount" | "skin" | null>(null);
  const [publishedReleaseId, setPublishedReleaseId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // 未完成操作的幂等标识：结果确定前保留，响应失败时用于重试与状态查询。
  const [pendingEdit, setPendingEdit] = useState<{ projectId: string; operationId: string } | null>(null);
  const [pendingCreateId, setPendingCreateId] = useState<string | null>(null);
  // Agent 活动卡片（设计 §7.3）：经活动 Studio 转发的 MCP 预览/提交/发布/试玩请求，
  // 新在前、有界保留；UI 自己的操作直连宿主、不出现在这里。
  const [agentActivity, setAgentActivity] = useState<ReadonlyArray<{ method: string; label: string; summary: string; ok: boolean; revision?: number; at: number }>>([]);
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
      mount: bindingsText !== saved.bindings || entryAnchorId !== saved.entry,
      skin: skinId !== saved.skin,
    };
  };
  const hasDrafts = (p: Project | null) => p !== null && Object.values(dirtyRegions(p)).some(Boolean);
  const applyProject = (next: Project, mode: "preserve" | "replace", previous: Project | null) => {
    const sameProject = previous !== null && previous.projectId === next.projectId;
    const dirty = sameProject ? dirtyRegions(previous) : null;
    const saved = savedForms(next);
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
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project;
  // 视口内移动的写通：把补丁经 preview→commit 提交到项目 revision（与 Agent/MCP
  // 共用同一草稿）。revision 被 Agent 推进时重读项目并用新 revision 重试一次；
  // operationId 绑定补丁内容，重复提交命中服务端幂等记录。本地存档由视口的
  // 修复会话负责，失败不回滚——状态区如实提示。
  const commitCityPatch = (patch: PlanPatchV1) => {
    void (async () => {
      let current = projectRef.current;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!current) return;
        const operationId = `patch:${patch.updatedAt}:${Object.keys(patch.buildingMoves).length}:${patch.roadOps.length}:${attempt}`;
        try {
          const preview = await creatorRequest<{ previewId: string }>("creator.scene.preview",
            { projectId: current.projectId, baseRevision: current.revision, operations: [{ op: "city.patch.upsert", patch }] });
          await creatorRequest("creator.scene.commit", { projectId: current.projectId, previewId: preview.previewId, expectedRevision: current.revision, operationId });
          const updated = await creatorRequest<Project>("creator.project.read", { projectId: current.projectId });
          applyRef.current(updated, "preserve", current);
          setMessage(`城市修改已写入项目（revision ${updated.revision}）。`);
          return;
        } catch (error) {
          const code = error instanceof Error ? error.message : "creator_patch_commit_failed";
          if (code === "revision_conflict" && attempt === 0) {
            try { current = await creatorRequest<Project>("creator.project.read", { projectId: current.projectId }); } catch { setMessage("项目补丁写入失败：无法重读当前项目。"); return; }
            continue;
          }
          setMessage(`项目补丁写入失败（${code}）；本地修改已保存。`);
          return;
        }
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
  // 顶栏项目选择器的二次确认目标（有草稿时第一次选择只提示）。
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
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
      creatorRequest<{ layouts: LayoutRow[] }>("creator.layout.list", { limit: 8 }),
    ]);
    setProjects(response.projects);
    setLayouts(layoutResponse.layouts);
    setWorldRevision(current => layoutResponse.layouts.some(layout => layout.worldRevision === current) ? current : layoutResponse.layouts[0]?.worldRevision ?? "");
  }, []);
  useEffect(() => {
    const methods = ["creator.layout.list", "creator.project.list", "creator.project.read", "creator.project.read_chunk", "creator.operation.status", "creator.project.create",
      "creator.game.preview", "creator.asset.import", "creator.game.commit", "creator.scene.preview", "creator.scene.commit", "creator.project.commit", "creator.project.publish",
      "creator.project.playtest.start", "creator.project.playtest.result", "creator.project.playtest.cancel", "creator.project.playtest.return_context", "creator.project.playtest.history",
      "creator.scene.describe", "creator.scene.inspect", "creator.scene.validate", "creator.capabilities.list"];
    // 这些调用只能来自宿主/MCP 路由（UI 自己的请求直连宿主、不经此转发），
    // 所以这里的捕获天然就是「Agent 来源」的变更记录——设计 §7.3 的变更卡片数据源。
    const noteAgent = (method: string, payload: Record<string, unknown>, ok: boolean, result: unknown) => {
      const labels: Record<string, string> = {
        "creator.project.create": "新建项目", "creator.game.preview": "规则预览", "creator.scene.preview": "场景预览",
        "creator.game.commit": "提交规则", "creator.scene.commit": "提交场景", "creator.project.commit": "Agent 提交",
        "creator.project.publish": "发布到 City", "creator.project.playtest.start": "请求试玩",
        "creator.project.playtest.cancel": "取消试玩", "creator.asset.import": "导入模型",
        "creator.scene.capture": "视口捕获",
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
    const handlers = Object.fromEntries(methods.map(method => [method, async (payload: Record<string, unknown>) => {
      let result: unknown;
      try {
        result = await creatorRequest(method, payload);
      } catch (error) {
        noteAgent(method, payload, false, null);
        throw error;
      }
      if (method === "creator.project.create" || method.endsWith(".commit")) window.dispatchEvent(new Event("__CREATOR_PROJECT_CHANGED__"));
      noteAgent(method, payload, true, result);
      return result;
    }]));
    // creator.scene.capture 在 WebView 本地完成（渲染器在这里，图像不出本机）；
    // describe/capabilities 走上面的转发、由 Rust 权威分发。projectRef 拿当前 revision。
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.scene.capture"] = async (payload: Record<string, unknown>) => {
      const engine = studioEngineRef.current;
      if (!engine) throw new Error("creator_capture_unavailable");
      // 契约要求捕获绑定捕获时的 revision：没有打开的项目就没有可绑定的 revision
      if (!projectRef.current) throw new Error("creator_capture_requires_project");
      if (typeof payload.revision === "number" && payload.revision !== projectRef.current.revision) throw new Error("revision_conflict");
      // 帧必须装进插件调用 64 KiB 邮箱（含信封开销）：引擎内部质量/分辨率逐档降级，
      // 全部档位用尽才报预算超限——与 creator_capture_unavailable（视口不可用）区分。
      const frame = engine.captureFrame();
      if (!frame) throw new Error("creator_capture_budget_exceeded");
      const camera = engine.inspectScene().camera as { position?: number[]; target?: number[] } | null;
      const result = { format: "image/jpeg", dataUrl: frame.dataUrl, width: frame.width, height: frame.height, downscaled: frame.downscaled,
        bytes: Math.ceil(frame.dataUrl.length * 0.75), revision: projectRef.current.revision,
        camera: camera ? { position: camera.position, target: camera.target } : null, capturedAtMs: Date.now() };
      noteAgent("creator.scene.capture", payload, true, { revision: projectRef.current.revision });
      return result;
    };
    const disconnectHostCalls = connectHostCalls(handlers);
    publishToolbar([]);
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
    return () => window.removeEventListener("__CREATOR_PROJECT_CHANGED__", changed);
  }, [project, refresh]);
  useEffect(() => { void refresh().catch(error => setMessage(error instanceof Error ? error.message : "creator_load_failed")); }, [refresh]);
  useEffect(() => {
    void creatorRequest<{ runId: string; projectId: string; revision: number; status: "completed" | "cancelled" | "failed";
      evidence?: { tick: number; counters: Record<string, number>; outcome: "success" | "failure" | null } | null; failureCode?: string | null } | null>("creator.project.playtest.return_context", {})
      .then(context => {
        if (!context) return;
        const counters = context.evidence ? Object.entries(context.evidence.counters).map(([key, value]) => `${key}=${value}`).join(", ") : "";
        const result = context.evidence ? ` · tick ${context.evidence.tick} · ${context.evidence.outcome ?? "未完成"}${counters ? ` · ${counters}` : ""}` : context.failureCode ? ` · ${context.failureCode}` : "";
        const message = `City 试玩已返回：${context.status} · revision ${context.revision}${result} · ${context.runId}`;
        // PRD：试玩结束回到同一编辑上下文——保留未提交草稿，并回到全局视角。
        void openProject(context.projectId, "preserve").then(() => { setFocusSignal(value => value + 1); setMessage(message); });
      }).catch(error => {
        const code = errorCode(error, "creator_playtest_return_failed");
        if (code !== "creator_playtest_not_found") setMessage(code);
      });
  }, []);

  const openProject = async (projectId: string, mode: "replace" | "preserve" = "replace") => {
    setBusy(true); setMessage(""); setPreviewId(null); setPreviewKind(null); setPublishedReleaseId(null);
    try {
      const next = await creatorRequest<Project>("creator.project.read", { projectId });
      applyProject(next, mode, project);
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
      const created = await creatorRequest<{ projectId: string }>("creator.project.create", { template, worldRevision, operationId });
      setPendingCreateId(null);
      await refresh(); await openProject(created.projectId);
      if (discardedDrafts) setMessage("已创建新项目；之前项目的未提交草稿已丢弃。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_create_failed"); }
    finally { setBusy(false); }
  };
  const preview = async () => {
    if (!project) return;
    setBusy(true); setMessage("");
    try {
      const game: unknown = JSON.parse(text);
      const result = await creatorRequest<{ previewId: string; diff: unknown }>("creator.game.preview", { projectId: project.projectId, baseRevision: project.revision, game });
      setPreviewId(result.previewId); setPreviewKind("game"); setMessage("规则预览通过。确认提交后生成新 revision。");
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
      const result = await creatorRequest<{ previewId: string }>("creator.scene.preview", { projectId: project.projectId, baseRevision: project.revision, operations });
      setPreviewId(result.previewId); setPreviewKind("scene"); setMessage(`场景预览通过（${operations.length} 项变更）。确认提交后生成新 revision。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_scene_preview_failed"); }
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
      const gameResult = validateMiniGamePack(JSON.parse(text));
      if (!gameResult.ok) throw new Error(gameResult.diagnostics[0]?.code ?? "creator_game_invalid");
      const layoutSnapshot = validateCityLayoutSnapshot(project.cityLayout);
      if (!layoutSnapshot.ok) throw new Error(layoutSnapshot.diagnostics[0]?.code ?? "creator_layout_not_bound");
      const layout = layoutSnapshot.value.layout;
      const bindings = JSON.parse(bindingsText) as Record<string, string[]>;
      if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw new Error("creator_mount_binding_invalid");
      const mount: CityGameMountV1 = {
        schemaVersion: 1, mountId: project.mounts[0]?.mountId ?? "main-mount",
        layout: { kind: "city-layout", id: layout.id, version: "1", digest: layoutSnapshot.value.worldRevision },
        game: { kind: "city-minigame", id: gameResult.value.id, version: "1", digest: await digest(gameResult.value) },
        entryAnchorId, bindings, parameterOverrides: {},
      };
      const mountResult = validateMount({ layout, game: gameResult.value, mount,
        resolvedRefs: { layout: { kind: "city-layout", id: layout.id, version: "1", digest: layoutSnapshot.value.worldRevision }, game: mount.game } });
      if (!mountResult.ok) throw new Error(mountResult.diagnostics[0]?.code ?? "creator_mount_invalid");
      const result = await creatorRequest<{ previewId: string }>("creator.scene.preview", {
        projectId: project.projectId, baseRevision: project.revision, operations: [{ op: "mount.bind", mount }],
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
    || bindingsText !== JSON.stringify(project.mounts?.[0]?.bindings ?? {}, null, 2)
    || entryAnchorId !== (project.mounts?.[0]?.entryAnchorId ?? project.cityLayout?.layout.anchors.find(anchor => anchor.kind === "spawn")?.id ?? "")
    || skinId !== (project.skinId ?? "miami-vice")
  );

  return <main className="studio">
    <header><div className="brand"><h1>Creator Studio</h1><select className="header-project-select" aria-label="选择城市项目" value={pendingSwitch ?? project?.projectId ?? ""} disabled={busy || projects.length === 0}
      onChange={event => {
        const targetId = event.target.value;
        if (!targetId || targetId === project?.projectId) return;
        // 与项目行同一守卫：有未提交草稿时第一次选择只提示，同一目标再选一次才丢弃切换。
        if (!hasDrafts(project) || pendingSwitch === targetId) {
          window.clearTimeout(switchTimer.current);
          setPendingSwitch(null);
          void openProject(targetId);
          return;
        }
        setPendingSwitch(targetId);
        setMessage("当前项目有未提交草稿；再次选择该项目确认丢弃并切换。");
        window.clearTimeout(switchTimer.current);
        switchTimer.current = window.setTimeout(() => setPendingSwitch(null), 5000);
      }}>
      <option value="" disabled>选择城市项目</option>
      {projects.map(row => <option key={row.projectId} value={row.projectId}>{row.title} · revision {row.revision}{pendingSwitch === row.projectId ? "（再次选择确认）" : ""}</option>)}
    </select></div><div className="header-actions"><span className="badge">{browserPreview ? "合成数据预览" : hasUncommittedProjectEdits ? "有未提交修改" : "本机项目"}</span><button className="secondary" disabled={busy || !publishedReleaseId || hasUncommittedProjectEdits} onClick={() => void startPlaytest()}>试玩</button><button disabled={busy || !project || hasUncommittedProjectEdits || (project.mounts?.length ?? 0) === 0} onClick={() => void publish()}>发布</button></div></header>
    <div className="workspace">
      <section className="viewport" aria-label="City 实时视口">
        <div className="viewport-head"><div className="section-title">城市视图</div><span className="viewport-hint">点选建筑移动 · 拖动旋转 · 滚轮缩放</span></div>
        {viewportSeed !== null
          ? <div className="viewport-frame"><CityViewport seed={viewportSeed} worldProfile={worldProfile} editable focusSignal={focusSignal}
              projectPatch={(project?.cityPatch ?? null) as PlanPatchV1 | null} onPatchCommit={patch => commitPatchRef.current(patch)}
              onEngineChange={engine => { studioEngineRef.current = engine; }} /></div>
          : <div className="empty viewport-empty">{viewportUnavailable
            ? "当前项目没有绑定的 City 布局快照，视口无法恢复它编辑的城市。请在 City 中重新生成道路地图后新建项目。"
            : "先打开 City 生成道路地图，这里会显示同一座实时城市。"}</div>}
      </section>
      <aside className="panel">
        <section className="agent-panel" aria-label="City Agent">
          <div className="section-title">City Agent</div>
          {agentActivity.length > 0 ? <div className="agent-activity">{agentActivity.map(item => <div key={item.at} className={`agent-card ${item.ok ? "" : "failed"}`}>
            <div className="agent-card-head"><span className="agent-label">{item.label}</span><span className="agent-time">{new Date(item.at).toLocaleTimeString()}</span></div>
            {item.summary && <p className="agent-summary">{item.summary}</p>}
            <p className="muted">{item.ok ? `已受理${item.revision !== undefined ? ` · revision ${item.revision}` : ""}` : "请求失败（错误码见状态区）"}</p>
          </div>)}</div>
          : <div className="agent-empty">
            <p><strong>Agent 对话将经 Studio MCP 接入</strong>：外部 Agent（Codex / Claude Code 等）对项目的预览、提交、发布和试玩请求会作为变更卡片显示在这里。</p>
            <p>当前可直接在左侧视口点选建筑移动（保存到同一草稿）；规则与场景在下方项目工具中编辑。</p>
          </div>}
        </section>
        <details className="project-tools" open>
          <summary>项目工具{project ? ` · ${project.title}` : ""}</summary>
        <section className="new-project">
          <label>新建模板<select value={template} disabled={busy} onChange={event => setTemplate(event.target.value)}><option value="checkpoint-race">驾驶检查点竞速</option><option value="collect-one">驾驶区域收集</option></select></label>
          <label>绑定 City 世界<select value={worldRevision} disabled={busy || layouts.length === 0} onChange={event => setWorldRevision(event.target.value)}>{layouts.map(layout => <option key={layout.worldRevision} value={layout.worldRevision}>{layout.layoutId} · seed {layout.seed} · {layout.anchorCount} 个锚点</option>)}</select></label>
          <button disabled={busy || !worldRevision} onClick={() => guardDrafts("create", () => void createProject())}>{switchConfirm === "create" ? "确认丢弃草稿并新建" : "新建项目"}</button>
          {layouts.length === 0 && <p className="muted">尚无 City 布局快照。先打开 City 生成道路地图，再回到 Studio。</p>}
        </section>
        <section className="editor">
        <div className="section-title">{project ? `游戏规则 · revision ${project.revision}` : "选择一个项目"}</div>
        {project ? <>
          <p className="muted">编辑声明式规则 JSON。脚本和未知动作会被拒绝。</p>
          <textarea aria-label="Mini-game JSON" spellCheck={false} value={text} disabled={busy} onChange={event => { setText(event.target.value); setPreviewId(null); setPreviewKind(null); }} />
          <div className="actions"><button className="secondary" disabled={busy} onClick={() => void preview()}>校验规则</button><button disabled={busy || !previewId || previewKind !== "game"} onClick={() => void commit()}>保存规则</button></div>
          <p className="muted">发布固定已保存 revision 的游戏规则、挂载与官方 City 皮肤；草稿、模型场景对象和分析数据不会进入 City 运行目录。</p>
          <details className="scene-editor">
            <summary>城市场景与组合</summary>
              <p className="muted">挂载绑定到项目创建时由 City 道路适配器捕获的布局版本。快照只含稳定锚点 ID，不携带几何；世界版本变化后试玩会拒绝启动。</p>
            <textarea aria-label="Scene draft JSON" spellCheck={false} value={sceneText} disabled={busy} onChange={event => { setSceneText(event.target.value); setPreviewId(null); setPreviewKind(null); }} />
            <section className="composition">
              <div className="section-title">模型资源</div>
              <p className="muted">GLB 文件通过桌面原生选择器导入并存入本机项目目录。文件路径和二进制内容不会传给 Agent/MCP。已发布版本可在 City 试玩中渲染受限的静态模型；模型实例与显式碰撞代理分别配置。</p>
              <div className="actions"><button className="secondary" disabled={busy || hasUncommittedProjectEdits} onClick={() => void importModel()}>从本机导入 GLB 并放入场景</button></div>
              {project.assets?.entries.map(asset => <code key={asset.assetId}>{asset.assetId} · {Math.ceil(asset.byteLength / 1024)} KiB · {asset.boundsMeters ? `${asset.boundsMeters.x.toFixed(1)}×${asset.boundsMeters.y.toFixed(1)}×${asset.boundsMeters.z.toFixed(1)} m` : "尺寸未知"}</code>)}
            </section>
            <div className="actions"><button className="secondary" disabled={busy} onClick={() => void previewScene()}>校验场景并预览</button><button disabled={busy || !previewId || previewKind !== "scene"} onClick={() => void commit()}>提交场景 revision</button></div>
            <section className="composition">
              <div className="section-title">小游戏挂载</div>
              <div className="anchor-catalog"><span className="muted">可用 City 锚点</span>{project.cityLayout?.layout.anchors.map(anchor => <code key={anchor.id}>{anchor.id} · {anchor.kind}</code>)}</div>
              <label>入口锚点<select value={entryAnchorId} disabled={busy || !project.cityLayout} onChange={event => { setEntryAnchorId(event.target.value); setPreviewId(null); }}>{project.cityLayout?.layout.anchors.filter(anchor => anchor.kind === "spawn" && anchor.capabilities.includes("drive")).map(anchor => <option key={anchor.id} value={anchor.id}>{anchor.id}</option>)}</select></label>
              <label>槽位绑定 JSON<textarea className="bindings" aria-label="Mount slot bindings JSON" spellCheck={false} value={bindingsText} disabled={busy} onChange={event => { setBindingsText(event.target.value); setPreviewId(null); }} /></label>
              <p className="muted">按游戏 slots 填入上方 City 锚点 ID，例如 {`{"points":["road-checkpoint:a","road-checkpoint:b"]}`}。SDK 与 Rust 都会校验槽位类型、能力和布局版本。</p>
              <div className="actions"><button className="secondary" disabled={busy} onClick={() => void previewMount()}>校验项目挂载</button><button disabled={busy || !previewId || previewKind !== "mount"} onClick={() => void commit()}>保存组合草稿</button></div>
            </section>
            <section className="composition">
              <div className="section-title">City 视觉皮肤</div>
              <label>官方皮肤<select value={skinId} disabled={busy} onChange={event => { setSkinId(event.target.value); setPreviewId(null); }}><option value="miami-vice">迈阿密霓虹</option><option value="desert-evening">沙漠暮色</option></select></label>
              <div className="actions"><button className="secondary" disabled={busy} onClick={() => void previewSkin(skinId)}>预览皮肤选择</button><button disabled={busy || !previewId || previewKind !== "skin"} onClick={() => void commit()}>保存皮肤 ID</button></div>
            </section>
          <p className="muted">试玩会临时应用发布版本的官方 City 皮肤，结束后恢复你的 City 外观与偏好。</p>
          </details>
        </> : <div className="empty">选择左侧项目，或创建一个小游戏模板。</div>}
        {message && <p className="status" role="status">{message}</p>}
        </section>
        </details>
      </aside>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
