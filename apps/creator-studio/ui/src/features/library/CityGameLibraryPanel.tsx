import { useCallback, useEffect, useRef, useState } from "react";
import { parseCodeBuilds, type CodeBuildRowV1 } from "../../codeGamePreview";
import { buildInstallCommitRequest, buildInstallRequest, canCommitInstall, installedGamesForCity, isInstallPreviewAllowed, LIBRARY_RESOURCE_KINDS, parseCityListPage, parseInstallations, parseInstallPreview, parseStoryProjects, type InstallPreview, type InstallRequest, type InstallationRow, type LibraryCityRow, type LibraryKind, type StoryProjectRow } from "./cityGameLibraryModel";
import { loadStudioValueAtStartup } from "../../startupLoad";

type Request = <T>(method: string, payload: Record<string, unknown>) => Promise<T>;

const errorMessage = (cause: unknown, fallback: string) => cause instanceof Error && cause.message ? cause.message : fallback;
const shortId = (value: string) => value.length > 12 ? `${value.slice(0, 12)}…` : value;
const formatDate = (value: number | null) => value === null ? "时间未知" : new Date(value).toLocaleString("zh-CN");
const formatSize = (value: number | null) => value === null ? "大小未知" : `${Math.max(1, Math.ceil(value / 1024))} KiB`;

function compatibilityLabel(city: LibraryCityRow): string {
  if (city.compatible === true) return "兼容";
  if (city.compatible === false) return "不兼容";
  if (city.compatibility) {
    const labels: Record<string, string> = { compatible: "兼容", incompatible: "不兼容", unknown: "兼容状态未知" };
    return labels[city.compatibility] ?? `兼容状态：${city.compatibility}`;
  }
  return "兼容状态未知";
}

export function CityGameLibraryPanel(props: Readonly<{
  request: Request;
  browserPreview: boolean;
  message: string;
  onMessage: (message: string) => void;
  onOpenPreview: (buildId: string, source?: Readonly<{ cityId: string; cityRevision: number }>) => void;
}>) {
  const { request, browserPreview, message, onMessage, onOpenPreview } = props;
  const [kind, setKind] = useState<LibraryKind>("city");
  const [cities, setCities] = useState<readonly LibraryCityRow[]>([]);
  const [citiesCursor, setCitiesCursor] = useState<string | null>(null);
  const [citiesLoading, setCitiesLoading] = useState(false);
  const [citiesError, setCitiesError] = useState("");
  const [builds, setBuilds] = useState<readonly CodeBuildRowV1[]>([]);
  const [buildsLoading, setBuildsLoading] = useState(false);
  const [buildsError, setBuildsError] = useState("");
  const [selectedBuildId, setSelectedBuildId] = useState("");
  const [installations, setInstallations] = useState<readonly InstallationRow[]>([]);
  const [installationsLoading, setInstallationsLoading] = useState(false);
  const [installationsError, setInstallationsError] = useState("");
  const [stories, setStories] = useState<readonly StoryProjectRow[]>([]);
  const [storiesLoading, setStoriesLoading] = useState(false);
  const [storiesError, setStoriesError] = useState("");
  const cityRequest = useRef(0);
  const buildRequest = useRef(0);
  const installationRequest = useRef(0);
  const storyRequest = useRef(0);

  const loadCities = useCallback(async (cursor?: string) => {
    const requestNumber = ++cityRequest.current;
    setCitiesLoading(true);
    setCitiesError("");
    try {
      const page = parseCityListPage(await loadStudioValueAtStartup(
        () => request("creator.city.list", { limit: 50, ...(cursor ? { cursor } : {}) }),
        { isCancelled: () => requestNumber !== cityRequest.current, delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)) },
      ));
      if (requestNumber !== cityRequest.current) return;
      setCities(current => cursor ? [...current, ...page.cities.filter(city => !current.some(item => item.cityId === city.cityId))] : page.cities);
      setCitiesCursor(page.nextCursor);
    } catch (cause) {
      if (requestNumber === cityRequest.current) setCitiesError(errorMessage(cause, "creator_city_list_unavailable"));
    } finally {
      if (requestNumber === cityRequest.current) setCitiesLoading(false);
    }
  }, [request]);

  const loadBuilds = useCallback(async () => {
    const requestNumber = ++buildRequest.current;
    setBuildsLoading(true);
    setBuildsError("");
    try {
      const rows = parseCodeBuilds(await loadStudioValueAtStartup(
        () => request("creator.code.builds.list", { limit: 50 }),
        { isCancelled: () => requestNumber !== buildRequest.current, delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)) },
      ));
      if (requestNumber !== buildRequest.current) return;
      setBuilds(rows);
      setSelectedBuildId(current => rows.some(row => row.buildId === current) ? current : rows[0]?.buildId ?? "");
    } catch (cause) {
      if (requestNumber === buildRequest.current) setBuildsError(errorMessage(cause, "creator_code_builds_unavailable"));
    } finally {
      if (requestNumber === buildRequest.current) setBuildsLoading(false);
    }
  }, [request]);

  const loadInstallations = useCallback(async () => {
    const requestNumber = ++installationRequest.current;
    setInstallationsLoading(true);
    setInstallationsError("");
    try {
      const rows = parseInstallations(await loadStudioValueAtStartup(
        () => request("creator.code.install.list", {}),
        { isCancelled: () => requestNumber !== installationRequest.current, delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)) },
      ));
      if (requestNumber === installationRequest.current) setInstallations(rows);
    } catch (cause) {
      if (requestNumber === installationRequest.current) setInstallationsError(errorMessage(cause, "creator_code_installations_unavailable"));
    } finally {
      if (requestNumber === installationRequest.current) setInstallationsLoading(false);
    }
  }, [request]);

  // Story 标签读宿主 Story Project Registry（creator.story.projects.list）：只显示
  // Registry 的真实注册项，绝不从 story_store 运行时数据推断项目（RFC §0.1）。
  const loadStories = useCallback(async () => {
    const requestNumber = ++storyRequest.current;
    setStoriesLoading(true);
    setStoriesError("");
    try {
      const rows = parseStoryProjects(await loadStudioValueAtStartup(
        () => request("creator.story.projects.list", { limit: 100 }),
        { isCancelled: () => requestNumber !== storyRequest.current, delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)) },
      ));
      if (requestNumber === storyRequest.current) setStories(rows);
    } catch (cause) {
      if (requestNumber === storyRequest.current) setStoriesError(errorMessage(cause, "creator_story_projects_unavailable"));
    } finally {
      if (requestNumber === storyRequest.current) setStoriesLoading(false);
    }
  }, [request]);

  useEffect(() => {
    void loadCities();
    void loadBuilds();
    void loadInstallations();
    void loadStories();
    return () => { cityRequest.current += 1; buildRequest.current += 1; installationRequest.current += 1; storyRequest.current += 1; };
  }, [loadBuilds, loadCities, loadInstallations, loadStories]);

  const selectedBuild = builds.find(build => build.buildId === selectedBuildId) ?? null;
  const [installBuild, setInstallBuild] = useState<CodeBuildRowV1 | null>(null);
  const [installRequest, setInstallRequest] = useState<InstallRequest | null>(null);
  const [installPreview, setInstallPreview] = useState<InstallPreview | null>(null);
  const [installBusy, setInstallBusy] = useState<"preview" | "commit" | null>(null);
  const [installError, setInstallError] = useState("");
  const [updateConfirmed, setUpdateConfirmed] = useState(false);
  const installSequence = useRef(0);
  const targetCity = installRequest ? cities.find(city => city.cityId === installRequest.targetCityId && city.revision === installRequest.expectedCityRevision) ?? null : null;

  const closeInstall = () => {
    installSequence.current += 1;
    setInstallBuild(null);
    setInstallRequest(null);
    setInstallPreview(null);
    setInstallBusy(null);
    setInstallError("");
    setUpdateConfirmed(false);
  };

  const openInstall = (build: CodeBuildRowV1) => {
    closeInstall();
    setInstallBuild(build);
    setInstallError("");
    void loadCities();
  };

  const previewTarget = async (build: CodeBuildRowV1, city: LibraryCityRow) => {
    const operationId = `install:${crypto.randomUUID()}`;
    const nextRequest = buildInstallRequest(build.buildId, city.cityId, city.revision, operationId);
    const sequence = ++installSequence.current;
    setInstallRequest(nextRequest);
    setInstallPreview(null);
    setInstallError("");
    setUpdateConfirmed(false);
    setInstallBusy("preview");
    try {
      const preview = parseInstallPreview(await request("creator.code.install.preview", nextRequest));
      if (sequence === installSequence.current) setInstallPreview(preview);
    } catch (cause) {
      if (sequence === installSequence.current) setInstallError(errorMessage(cause, "creator_code_install_preview_failed"));
    } finally {
      if (sequence === installSequence.current) setInstallBusy(null);
    }
  };

  const commitInstall = async () => {
    if (!installBuild || !installRequest || !installPreview?.previewId || !canCommitInstall(installPreview, updateConfirmed) || installBusy) return;
    const sequence = ++installSequence.current;
    setInstallBusy("commit");
    setInstallError("");
    try {
      await request("creator.code.install.commit", buildInstallCommitRequest(installPreview, installBuild.buildId, `install-commit:${crypto.randomUUID()}`));
      if (sequence !== installSequence.current) return;
      const cityName = targetCity?.name ?? installRequest.targetCityId;
      onMessage(`已将 ${installBuild.gameId} 安装到 ${cityName}；未立即运行、未替换当前视图、未写入正式 Story。`);
      closeInstall();
      await Promise.all([loadInstallations(), loadCities()]);
    } catch (cause) {
      if (sequence === installSequence.current) setInstallError(errorMessage(cause, "creator_code_install_commit_failed"));
    } finally {
      if (sequence === installSequence.current) setInstallBusy(null);
    }
  };

  return <section className="city-game-library" aria-label="City 实例与 Game Build">
    <div className="library-catalog">
      <div className="library-heading">
        <div><span className="welcome-kicker">CREATOR ENTITIES</span><h2>City 实例与 Game Build</h2><p>City 实例、可编辑 Project 和不可变 Build 使用不同身份；这里不把 Build 当作可编辑项目。</p></div>
        <button className="secondary" disabled={kind === "city" ? citiesLoading : kind === "story" ? storiesLoading : buildsLoading} onClick={() => void (kind === "city" ? loadCities() : kind === "story" ? loadStories() : loadBuilds())}>{`刷新${kind === "city" ? "City" : kind === "story" ? "Story" : "Build"}`}</button>
      </div>
      {message && <p className="status status-banner" role="status">{message}</p>}
      <div className="library-type-tabs" role="tablist" aria-label="资源类型">
        {LIBRARY_RESOURCE_KINDS.map(resource => <button key={resource.id} role="tab" aria-selected={kind === resource.id} className={kind === resource.id ? "active" : ""} disabled={!resource.available} title={resource.available ? undefined : resource.description} onClick={() => setKind(resource.id)}>
          <strong>{resource.label}</strong><span>{resource.id === "city" ? `${resource.description} · ${cities.length} 项` : resource.id === "game" ? `${resource.description} · ${builds.length} 项` : `${resource.description} · ${stories.length} 项`}</span>
        </button>)}
      </div>

      {kind === "city" && <section className="library-list" aria-label="City 实例列表">
        {citiesLoading && cities.length === 0 && <div className="empty library-empty">正在读取真实 City 实例…</div>}
        {citiesError && <p className="library-error" role="alert">City 实例读取失败（{citiesError}）。</p>}
        {!citiesLoading && !citiesError && cities.length === 0 && <div className="empty library-empty">尚无已保存的 City 实例。请先在项目面板创建或保存 City。</div>}
        <div className="library-grid">{cities.map(city => <article className="library-card" key={city.cityId}>
          <div className="library-card-top"><span className="resource-kind">CITY INSTANCE</span><span className={`compatibility ${city.compatible === false ? "incompatible" : ""}`}>{compatibilityLabel(city)}</span></div>
          <h3>{city.name}</h3><code title={city.cityId}>{shortId(city.cityId)}</code>
          <dl><div><dt>City Revision</dt><dd>{city.revision}</dd></div><div><dt>世界版本</dt><dd>{city.worldRevision ?? "未知"}</dd></div></dl>
          <div className="capability-block"><span>世界能力</span>{city.capabilities === null ? <p>能力信息不可用</p> : city.capabilities.length === 0 ? <p>未声明能力</p> : <div className="capability-list">{city.capabilities.map(capability => <code key={capability}>{capability}</code>)}</div>}</div>
          <div className="city-installed-games"><span>已安装游戏</span>{installedGamesForCity(installations, city.cityId).length === 0 ? <p>暂无已安装游戏</p> : installedGamesForCity(installations, city.cityId).map(item => <div key={item.installationId}>
            <code>{item.gameId} · Build {shortId(item.buildId)}</code>
            <button className="secondary" disabled={browserPreview} onClick={() => onOpenPreview(item.buildId, { cityId: city.cityId, cityRevision: city.revision })}>在独立 Preview 中启动</button>
          </div>)}</div>
        </article>)}</div>
        {citiesCursor && <button className="secondary library-more" disabled={citiesLoading} onClick={() => void loadCities(citiesCursor)}>{citiesLoading ? "正在读取…" : "加载更多 City"}</button>}
      </section>}

      {kind === "game" && <section className="library-list" aria-label="不可变 Game Build 列表">
        <div className="library-note"><strong>Build 不是可编辑 Project</strong><span>此列表只提供查看、测试和安装。模板 Game 请在项目面板编辑；Code Game 需通过 Agent/MCP 生成新 Build。</span></div>
        {buildsLoading && builds.length === 0 && <div className="empty library-empty">正在读取不可变 Game Build…</div>}
        {buildsError && <p className="library-error" role="alert">Game Build 读取失败（{buildsError}）。</p>}
        {!buildsLoading && !buildsError && builds.length === 0 && <div className="empty library-empty">尚无 Game Build。这里不会把构建产物列为可编辑项目；请先通过 Agent/MCP 完成 Build。</div>}
        <div className="library-grid">{builds.map(build => <button key={build.buildId} className={`library-card game-card ${selectedBuildId === build.buildId ? "selected" : ""}`} aria-pressed={selectedBuildId === build.buildId} onClick={() => setSelectedBuildId(build.buildId)}>
          <div className="library-card-top"><span className="resource-kind">GAME BUILD</span><span className="validation">验证信息未知</span></div>
          <h3>{build.gameId}</h3><span className="game-version">版本 {build.gameVersion ?? "未知"}</span>
          <dl><div><dt>Build</dt><dd><code title={build.buildId}>{shortId(build.buildId)}</code></dd></div><div><dt>构建时间</dt><dd>{formatDate(build.createdAtMs)}</dd></div></dl>
        </button>)}</div>
      </section>}

      {kind === "story" && <section className="library-list" aria-label="Story Project 注册表列表">
        <div className="library-note"><strong>Story 是宿主 Registry 的注册项</strong><span>storyId 是稳定内容身份，安装/Run/租约生命周期由宿主权威管理；这里不从对话或运行时数据推断项目。</span></div>
        {storiesLoading && stories.length === 0 && <div className="empty library-empty">正在读取宿主 Story Project 注册表…</div>}
        {storiesError && <p className="library-error" role="alert">Story Project 读取失败（{storiesError}）。</p>}
        {!storiesLoading && !storiesError && stories.length === 0 && <div className="empty library-empty">宿主 Story Project 注册表为空。注册 Story 请通过 Agent/MCP 的 creator_story_project_create 完成，这里保持真实空态。</div>}
        <div className="library-grid">{stories.map(story => <article className="library-card" key={story.storyId}>
          <div className="library-card-top"><span className="resource-kind">STORY PROJECT</span><span className="validation">Registry revision {story.revision}</span></div>
          <h3>{story.title}</h3><code title={story.storyId}>{shortId(story.storyId)}</code>
          <dl><div><dt>版本</dt><dd>{story.storyVersion}</dd></div><div><dt>内容摘要</dt><dd><code title={story.contentDigest}>{shortId(story.contentDigest)}</code></dd></div></dl>
          <dl><div><dt>结构预算</dt><dd>{story.graphBytes === null ? "未知" : formatSize(story.graphBytes)} graph · {story.canonBytes === null ? "未知" : formatSize(story.canonBytes)} canon</dd></div><div><dt>更新时间</dt><dd>{formatDate(story.updatedAtMs)}</dd></div></dl>
        </article>)}</div>
      </section>}

      <section className="installation-history" aria-label="安装记录">
        <div className="installation-heading"><div><span className="section-title">City ↔ Game 安装记录</span><p>关系状态独立于 City 资源版本和 Game 构建。</p></div><button className="secondary" disabled={installationsLoading} onClick={() => void loadInstallations()}>刷新记录</button></div>
        {installationsLoading && installations.length === 0 && <p className="muted">正在读取安装记录…</p>}
        {installationsError && <p className="library-error" role="alert">安装记录读取失败（{installationsError}）。</p>}
        {!installationsLoading && !installationsError && installations.length === 0 && <p className="muted">暂无真实安装记录。</p>}
        {installations.length > 0 && <div className="installation-list">{installations.map(item => <article key={item.installationId}>
          <div><strong>{item.gameId}</strong><span> → {cities.find(city => city.cityId === item.cityId)?.name ?? item.cityId}</span></div>
          <code>Build {shortId(item.buildId)} · Installation {shortId(item.installationId)}</code>
          <p>{item.status === "installed" ? "已安装" : item.status === "disabled" ? "已停用" : item.status === "update-available" ? "可更新" : "状态未知"} · City 版本 {item.cityRevision ?? "未知"} · {formatDate(item.createdAtMs)}</p>
        </article>)}</div>}
      </section>
    </div>

    <aside className="library-inspector" aria-label="资源详情">
      <span className="sidebar-kicker">{kind === "city" ? "CITY INSTANCE" : kind === "story" ? "STORY PROJECT REGISTRY" : "IMMUTABLE GAME BUILD"}</span>
      <h2>{kind === "city" ? "City 实例" : kind === "story" ? "Story Project（宿主 Registry）" : "Game Build（不可编辑）"}</h2>
      {kind === "city" ? <><p>这里只展示 Host 返回的 City 实例；cityId 和 City Revision 不会冒充 projectId 和项目 Revision。能力和兼容字段缺失时明确标记为不可用或未知。</p><div className="library-note"><strong>安装不是 City 内容替换</strong><span>安装 Game 只添加游戏入口，不替换地形、建筑、世界包或其他游戏。</span></div></>
        : kind === "story" ? <><p>这里展示宿主 Story Project Registry 的真实注册项：storyId、不可变版本与内容摘要。安装（preview/commit）、StoryRun 与 NPC 公共活动租约由宿主权威管理，MCP 工具面见 creator_story_* 系列。</p><div className="library-note"><strong>空态是真实的</strong><span>注册表为空时这里不会显示推断出的项目；Story 事实（事件、状态）仍走既有 story store 的显式 scope 写入。</span></div></>
        : selectedBuild ? <><div className="build-identity"><span>CANDIDATE BUILD</span><h3>{selectedBuild.gameId}</h3><code>{selectedBuild.buildId}</code></div>
          <dl className="build-facts"><div><dt>游戏版本</dt><dd>{selectedBuild.gameVersion ?? "未知"}</dd></div><div><dt>验证信息</dt><dd>未知</dd></div><div><dt>构建大小</dt><dd>{formatSize(selectedBuild.byteLength)}</dd></div><div><dt>创建时间</dt><dd>{formatDate(selectedBuild.createdAtMs)}</dd></div></dl>
          <div className="actions"><button disabled={browserPreview} onClick={() => onOpenPreview(selectedBuild.buildId)}>打开独立 Preview</button>
            <button className="secondary" disabled={browserPreview} onClick={() => openInstall(selectedBuild)}>安装到 City…</button></div>
          {browserPreview && <p className="muted">浏览器预览不能启动宿主 Preview 或执行真实安装，请在桌面应用中操作。</p>}
          <div className="library-note"><strong>默认仅安装</strong><span>不会立即运行、替换当前 City 视图或写入正式 Story；这些授权不会被默认勾选。</span></div></>
        : <div className="empty inspector-empty">选择一个游戏构建以查看详情和安装入口。</div>}
    </aside>

    {installBuild && <div className="install-dialog-backdrop"><section className="install-dialog" role="dialog" aria-modal="true" aria-labelledby="install-dialog-title">
      <div className="install-dialog-heading"><div><span className="welcome-kicker">INSTALL CONFIRMATION</span><h2 id="install-dialog-title">安装到 City</h2></div><button className="secondary" disabled={installBusy === "commit"} onClick={closeInstall}>取消</button></div>
      <p className="install-source">{installBuild.gameId} · 版本 {installBuild.gameVersion ?? "未知"} · Build {shortId(installBuild.buildId)}</p>
      <div className="install-options" aria-label="本次安装授权"><strong>本次仅安装到所选 City</strong><span>安装后不立即运行</span><span>不替换当前 City 视图</span><span>不允许写入正式 Story</span></div>
      <fieldset className="install-targets" disabled={installBusy !== null}><legend>1. 选择真实 City 实例并预检</legend>
        {citiesLoading && cities.length === 0 && <p className="muted">正在读取 City 实例…</p>}
        {citiesError && <p className="library-error" role="alert">无法取得可信 City 列表（{citiesError}）。</p>}
        {!citiesLoading && !citiesError && cities.length === 0 && <p className="muted">没有可选择的已保存 City 实例。取消后请先在项目面板创建 City。</p>}
        {cities.map(city => <label className={`install-target ${installRequest?.targetCityId === city.cityId ? "selected" : ""}`} key={city.cityId}>
          <input type="radio" name="install-target-city" checked={installRequest?.targetCityId === city.cityId && installRequest.expectedCityRevision === city.revision} onChange={() => void previewTarget(installBuild, city)} />
          <span><strong>{city.name}</strong><code>{shortId(city.cityId)} · 版本 {city.revision}</code><small>{city.capabilities === null ? "能力信息不可用" : city.capabilities.length ? city.capabilities.join(" · ") : "未声明能力"} · {compatibilityLabel(city)}</small></span>
        </label>)}
        {citiesCursor && <button type="button" className="secondary" disabled={citiesLoading || installBusy !== null} onClick={() => void loadCities(citiesCursor)}>加载更多 City</button>}
      </fieldset>
      <section className="install-preview" aria-label="安装预检结果" aria-live="polite"><span className="section-title">2. 检查宿主预检诊断</span>
        {installBusy === "preview" && <p className="muted">正在执行安装预检…</p>}
        {!installRequest && installBusy !== "preview" && <p className="muted">选择目标后才会请求预检；取消不会提交安装。</p>}
        {installRequest && installBusy !== "preview" && !installPreview && !installError && <p className="muted">尚未取得预检结果。</p>}
        {installPreview && <>{isInstallPreviewAllowed(installPreview) ? <p className="install-ok">宿主明确允许安装；确认后才会提交。</p> : <p className="library-error">宿主未明确允许当前安装，确认按钮已禁用。</p>}
          {installPreview.diagnostics.length === 0 ? <p className="muted">宿主未返回诊断明细。</p> : <ul>{installPreview.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}:${index}`} className={`diagnostic ${diagnostic.severity}`}><strong>{diagnostic.severity === "error" ? "错误" : diagnostic.severity === "warning" ? "警告" : diagnostic.severity === "info" ? "信息" : "未知级别"} · {diagnostic.code}</strong><span>{diagnostic.message}</span>{diagnostic.path && <code>{diagnostic.path}</code>}</li>)}</ul>}</>}
        {installRequest && targetCity && installBusy === null && <button className="secondary" onClick={() => void previewTarget(installBuild, targetCity)}>重新预检</button>}
      </section>
      {installPreview?.requiresUpdateConfirmation && <label className="install-update-confirmation">
        <input type="checkbox" checked={updateConfirmed} disabled={installBusy !== null} onChange={event => setUpdateConfirmed(event.target.checked)} />
        <span>确认更新现有安装：从 Build <code>{shortId(installPreview.currentBuildId ?? "未知")}</code> 更新为 <code>{shortId(installBuild.buildId)}</code>。其他 City 的安装关系不受影响。</span>
      </label>}
      {installError && <p className="library-error" role="alert">安装操作失败（{installError}）。{installRequest && !installPreview ? "可重新选择目标生成新预检。" : "请检查诊断或重试。"}</p>}
      <div className="install-confirm"><p>提交绑定 Build、目标 City 版本和操作 ID。预检不等于安装成功。</p><div className="actions"><button className="secondary" disabled={installBusy === "commit"} onClick={closeInstall}>取消，不安装</button><button disabled={installBusy !== null || !canCommitInstall(installPreview, updateConfirmed)} onClick={() => void commitInstall()}>{installBusy === "commit" ? "正在提交…" : installPreview?.requiresUpdateConfirmation ? "确认更新安装" : "确认仅安装"}</button></div></div>
    </section></div>}
  </section>;
}
