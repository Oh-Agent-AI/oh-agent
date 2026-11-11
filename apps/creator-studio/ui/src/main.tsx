import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectHostCalls, invokeHost, observeHealth, publishToolbar } from "@agent-vitals/app-sdk/ui-host";
import { canonicalJson, validateCityLayoutSnapshot, validateMiniGamePack, validateMount, type CityGameMountV1, type CityLayoutSnapshotV1 } from "@agent-vitals/city-sdk";
// 视口与 City 插件共享同一份引擎与装配管线，保证 Studio 看到的是同一座城市。
import { CityViewport } from "../../../agent-city/ui/src/viewport/CityViewport";
import { readCityAppearancePreference } from "../../../agent-city/ui/src/engine/cityWorldProfile";
import "./style.css";

type ProjectRow = { projectId: string; revision: number; title: string; updatedAtMs: number };
type LayoutRow = { worldRevision: string; layoutId: string; seed: number; anchorCount: number; updatedAtMs: number };
type SceneDraft = { schemaVersion: 1; objects: Array<Record<string, unknown>> };
type Project = { projectId: string; revision: number; kind: string; game: unknown; cityLayout?: CityLayoutSnapshotV1 | null; scene?: SceneDraft; assets?: { schemaVersion: 1; entries: Array<{ assetId: string; relativePath: string; sha256: string; byteLength: number; format: "glb-v2"; boundsMeters?: { x: number; y: number; z: number } }> }; assetRefs?: Array<Record<string, unknown>>; mounts: CityGameMountV1[]; skinId?: string };
type PluginResponse<T> = { version: number; requestId: string; ok: boolean; result?: T; error?: { code: string } };
let sequence = 0;

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
      "creator.project.playtest.start", "creator.project.playtest.return_context", "creator.project.playtest.history"];
    const handlers = Object.fromEntries(methods.map(method => [method, async (payload: Record<string, unknown>) => {
      const result = await creatorRequest(method, payload);
      if (method === "creator.project.create" || method.endsWith(".commit")) window.dispatchEvent(new Event("__CREATOR_PROJECT_CHANGED__"));
      return result;
    }]));
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
        setProject(current); setText(JSON.stringify(current.game, null, 2));
        setSceneText(JSON.stringify(current.scene ?? { schemaVersion: 1, objects: [] }, null, 2));
        setEntryAnchorId(current.mounts?.[0]?.entryAnchorId ?? current.cityLayout?.layout.anchors.find(anchor => anchor.kind === "spawn")?.id ?? "");
        setBindingsText(JSON.stringify(current.mounts?.[0]?.bindings ?? {}, null, 2));
        setSkinId(current.skinId ?? "miami-vice");
        setPreviewId(null); setPreviewKind(null);
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
        void openProject(context.projectId).then(() => setMessage(message));
      }).catch(error => {
        const code = errorCode(error, "creator_playtest_return_failed");
        if (code !== "creator_playtest_not_found") setMessage(code);
      });
  }, []);

  const openProject = async (projectId: string) => {
    setBusy(true); setMessage(""); setPreviewId(null); setPreviewKind(null); setPublishedReleaseId(null);
    try {
      const next = await creatorRequest<Project>("creator.project.read", { projectId });
      setProject(next); setText(JSON.stringify(next.game, null, 2));
      setSceneText(JSON.stringify(next.scene ?? { schemaVersion: 1, objects: [] }, null, 2));
      setEntryAnchorId(next.mounts?.[0]?.entryAnchorId ?? next.cityLayout?.layout.anchors.find(anchor => anchor.kind === "spawn")?.id ?? "");
      setBindingsText(JSON.stringify(next.mounts?.[0]?.bindings ?? {}, null, 2));
      setSkinId(next.skinId ?? "miami-vice");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_read_failed"); }
    finally { setBusy(false); }
  };
  const createProject = async () => {
    setBusy(true); setMessage("");
    try {
      if (!worldRevision) throw new Error("creator_layout_not_bound");
      const created = await creatorRequest<{ projectId: string }>("creator.project.create", { template, worldRevision, operationId: `create:${crypto.randomUUID()}` });
      await refresh(); await openProject(created.projectId);
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
      const scene: SceneDraft = JSON.parse(sceneText);
      const model = { id: `model-${crypto.randomUUID()}`, kind: "model", asset: imported.assetRef, transform: {
        positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      } };
      setProject(updated); setText(JSON.stringify(updated.game, null, 2));
      setSceneText(JSON.stringify({ ...scene, objects: [...scene.objects, model] }, null, 2));
      setPreviewId(null); setPreviewKind(null); setPublishedReleaseId(null); await refresh();
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
    try {
      await creatorRequest(previewKind === "game" ? "creator.game.commit" : "creator.scene.commit", { projectId: project.projectId, previewId, expectedRevision: project.revision, operationId: `edit:${crypto.randomUUID()}` });
      setPreviewId(null); setPublishedReleaseId(null); await openProject(project.projectId); await refresh(); setMessage("已保存新版本。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "creator_commit_failed"); }
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
    <header><div><span className="eyebrow">OH AGENT · CITY SDK</span><h1>Creator Studio</h1><p>用 Agent 或编辑器创建可验证的 City 小游戏。</p></div><span className="badge">本机项目</span></header>
    <section className="new-project">
      <label>新建模板<select value={template} disabled={busy} onChange={event => setTemplate(event.target.value)}><option value="checkpoint-race">驾驶检查点竞速</option><option value="collect-one">驾驶区域收集</option></select></label>
      <label>绑定 City 世界<select value={worldRevision} disabled={busy || layouts.length === 0} onChange={event => setWorldRevision(event.target.value)}>{layouts.map(layout => <option key={layout.worldRevision} value={layout.worldRevision}>{layout.layoutId} · seed {layout.seed} · {layout.anchorCount} 个锚点</option>)}</select></label>
      <button disabled={busy || !worldRevision} onClick={() => void createProject()}>新建项目</button>
      {layouts.length === 0 && <p className="muted">尚无 City 布局快照。先打开 City 生成道路地图，再回到 Studio。</p>}
    </section>
    <section className="viewport" aria-label="City 实时视口">
      <div className="section-title">City 实时视口{viewportSeed !== null ? ` · seed ${viewportSeed}` : ""}</div>
      {viewportSeed !== null
        ? <div className="viewport-frame"><CityViewport seed={viewportSeed} worldProfile={worldProfile} /></div>
        : <div className="empty viewport-empty">{viewportUnavailable
          ? "当前项目没有绑定的 City 布局快照，视口无法恢复它编辑的城市。请在 City 中重新生成道路地图后新建项目。"
          : "先打开 City 生成道路地图，这里会显示同一座实时城市。"}</div>}
    </section>
    <div className="workspace">
      <aside><div className="section-title">我的项目</div>{projects.length === 0 ? <p className="muted">还没有项目。创建一个模板开始。</p> : projects.map(row => <button className={`project-row ${project?.projectId === row.projectId ? "selected" : ""}`} key={row.projectId} disabled={busy} onClick={() => void openProject(row.projectId)}><strong>{row.title}</strong><span>revision {row.revision}</span></button>)}</aside>
      <section className="editor">
        <div className="section-title">{project ? `${project.projectId} · revision ${project.revision}` : "选择一个项目"}</div>
        {project ? <>
          <p className="muted">编辑声明式规则 JSON。脚本和未知动作会被拒绝。</p>
          <textarea aria-label="Mini-game JSON" spellCheck={false} value={text} disabled={busy} onChange={event => { setText(event.target.value); setPreviewId(null); setPreviewKind(null); }} />
          <div className="actions"><button className="secondary" disabled={busy} onClick={() => void preview()}>校验规则并预览</button><button disabled={busy || !previewId || previewKind !== "game"} onClick={() => void commit()}>提交 revision</button>
            <button disabled={busy || hasUncommittedProjectEdits || (project.mounts?.length ?? 0) === 0} onClick={() => void publish()}>发布已保存版本到 City</button></div>
          <div className="actions"><button className="secondary" disabled={busy || !publishedReleaseId || hasUncommittedProjectEdits} onClick={() => void startPlaytest()}>在 City 试玩已发布版本</button></div>
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
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
