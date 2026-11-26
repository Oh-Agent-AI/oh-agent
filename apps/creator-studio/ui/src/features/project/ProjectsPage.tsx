import { useRef, useState, type ReactNode } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import type { CityRow, LayoutRow, ProjectRow } from "../../contracts/creatorStudio";
import { CityArchivePanel } from "../city/CityArchivePanel";
import type { ArchivedCity, CityArchivePreview } from "../../contracts/cityLifecycle";
import { catalogEntries, catalogKey, catalogLabels, visibleCatalogEntries, type CatalogEntry, type CatalogKind } from "./projectCatalogModel";
import { useCatalogStories } from "./useProjectCatalogData";
import { CatalogDetails, catalogCover } from "./CatalogDetails";
import "./projectsPage.css";

const filters: readonly CatalogKind[] = ["all", "game", "story", "city"];

export function ProjectsPage(props: Readonly<{
  request: CreatorRequest;
  projects: readonly ProjectRow[];
  projectsLoading: boolean;
  projectsError: string;
  cities: readonly CityRow[];
  layouts: readonly LayoutRow[];
  citiesLoading: boolean;
  citiesError: boolean;
  busy: boolean;
  browserPreview: boolean;
  search: string;
  onSearchChange: (search: string) => void;
  onCreateGame: () => void;
  start: ReactNode;
  onOpenStoryTool: () => void;
  onOpenProject: (projectId: string) => void;
  onConfigureGame: (projectId: string) => void;
  onOpenStory: (storyId: string) => void;
  onRefreshProjects: () => void;
  onOpenCity: (cityId: string, revision: number) => void;
  onOpenGamePreview: (buildId: string, cityId: string) => void;
  onRefreshCities: () => void;
  archivedCities: readonly ArchivedCity[];
  archivesLoading: boolean;
  archivesError: string;
  archivePreview: CityArchivePreview | null;
  onPreviewCityArchive: (city: CityRow) => void;
  onCommitCityArchive: () => void;
  onCancelCityArchivePreview: () => void;
  onRestoreCityArchive: (cityId: string) => void;
}>) {
  const {
    request, projects, projectsLoading, projectsError, cities, layouts, citiesLoading, citiesError, busy, browserPreview,
    search, onSearchChange, onCreateGame, start, onOpenStoryTool,
    onOpenProject, onConfigureGame, onOpenStory, onRefreshProjects, onOpenCity, onOpenGamePreview, onRefreshCities,
    archivedCities, archivesLoading, archivesError, archivePreview, onPreviewCityArchive, onCommitCityArchive, onCancelCityArchivePreview, onRestoreCityArchive,
  } = props;
  const [kind, setKind] = useState<CatalogKind>("all");
  const [sort, setSort] = useState<"name" | "recent">("recent");
  const [selection, setSelection] = useState("");
  const detailRef = useRef<HTMLElement>(null);
  const storyCatalog = useCatalogStories(request);
  const visible = visibleCatalogEntries(catalogEntries(projects, storyCatalog.stories, cities), kind, search, kind === "city" ? "name" : sort);
  const selected = visible.find(entry => catalogKey(entry) === selection) ?? visible[0];
  const sources = [
    ...(kind === "all" || kind === "game" ? [{ label: "Game 项目", loading: projectsLoading, failed: !!projectsError, retry: onRefreshProjects }] : []),
    ...(kind === "all" || kind === "story" ? [{ label: "Story 项目", loading: storyCatalog.status === "loading", failed: storyCatalog.status === "failed", retry: storyCatalog.retry }] : []),
    ...(kind === "city" ? [{ label: "City 实例", loading: citiesLoading, failed: citiesError, retry: onRefreshCities }] : []),
  ];
  const loading = sources.some(source => source.loading);
  const failed = sources.some(source => source.failed);
  const open = (entry: CatalogEntry) => {
    if (entry.kind === "game") onOpenProject(entry.id);
    else if (entry.kind === "story") onOpenStory(entry.id);
    else onOpenCity(entry.id, entry.revision);
  };
  const actionLabel = (entry: CatalogEntry) => entry.kind === "city" || (entry.kind === "story" && browserPreview) ? "打开只读预览" : "继续编辑";
  const counts = { all: projects.length + storyCatalog.stories.length, game: projects.length, story: storyCatalog.stories.length, city: cities.length };
  const countKnown = { all: !projectsError && !projectsLoading && storyCatalog.status === "ready", game: !projectsError && !projectsLoading,
    story: storyCatalog.status === "ready", city: !citiesError && !citiesLoading };
  const searching = search.trim() !== "";
  const emptyLabel = {
    all: "还没有作品。", game: "还没有 Game 项目。", story: "还没有 Story 项目。", city: "还没有可预览的 City 实例。",
  }[kind];
  return <div className="studio-catalog">
    {start}
    <div className="studio-catalog-tools">
      <nav aria-label="项目与实例">
        {filters.map(filter => <button key={filter} aria-pressed={kind === filter} onClick={() => setKind(filter)}>
          {catalogLabels[filter]}{countKnown[filter] && <span>{counts[filter]}</span>}
        </button>)}
      </nav>
      {kind !== "city" && <select aria-label="排序" value={sort} onChange={event => setSort(event.target.value === "name" ? "name" : "recent")}>
        <option value="recent">最近修改</option><option value="name">按名称</option>
      </select>}
    </div>
    <div className="studio-catalog-grid">
      <section className="studio-catalog-list" aria-label={`${catalogLabels[kind]}列表`}>
        {searching && <div className="catalog-list-tools"><div className="catalog-search-summary">
            <p role="status">{loading || failed ? `已读取的记录中有 ${visible.length} 项匹配` : `${visible.length} 个匹配结果`}</p>
            <button onClick={() => onSearchChange("")}>清除搜索</button>
        </div></div>}
        {sources.filter(source => source.failed).map(source => <p key={source.label} className="library-error" role="alert">{source.label}读取失败。 <button onClick={source.retry} disabled={busy}>重试</button></p>)}
        {loading && <p role="status">正在读取…</p>}
        {!loading && !failed && visible.length === 0 && <div className="catalog-empty">
          <p>{searching ? "试试其他名称，或切换上方的项目类型。" : emptyLabel}</p>
          {!searching && (kind === "all" || kind === "game") && <button disabled={busy} onClick={onCreateGame}>新建 Game 项目</button>}
          {!searching && kind === "story" && !browserPreview && <button disabled={busy} onClick={onOpenStoryTool}>打开 Story 工具</button>}
        </div>}
        <div className="studio-catalog-cards">{visible.map(entry => <article key={catalogKey(entry)} className={entry === selected ? "is-selected" : ""}>
          <button className="catalog-card-select" aria-pressed={entry.kind === "city" ? entry === selected : undefined}
            aria-label={entry.kind === "city" ? undefined : `${actionLabel(entry)} ${entry.name}`} disabled={entry.kind !== "city" && busy}
            onClick={() => { setSelection(catalogKey(entry)); if (entry.kind !== "city") open(entry); }}>
            <img className="catalog-card-art" src={catalogCover(entry)} alt="" loading="lazy" width="840" height="630" />
            <span className="catalog-card-body">
              <span className="catalog-card-title">{entry.name}</span>
              <span className="catalog-card-caption" data-kind={entry.kind}>{catalogLabels[entry.kind]}{entry.version ? ` · v${entry.version}` : ""}</span>
            </span>
          </button>
          <div className="catalog-card-footer">
            {entry.kind !== "city" && <button className="catalog-inspect" aria-label={`查看详情 ${entry.name}`}
              aria-controls="catalog-selected-details" aria-pressed={entry === selected} onClick={() => {
                setSelection(catalogKey(entry));
                detailRef.current?.focus({ preventScroll: window.matchMedia("(min-width: 721px)").matches });
              }}>详情</button>}
            {entry.kind === "city" && <button className="catalog-narrow-open" disabled={busy} onClick={() => open(entry)}>{actionLabel(entry)}</button>}
          </div>
        </article>)}</div>
        {kind === "city" && !browserPreview && <details className="catalog-archive">
          <summary>归档与恢复</summary>
          <CityArchivePanel cities={cities} archivedCities={archivedCities} archivesLoading={archivesLoading} archivesError={archivesError} preview={archivePreview} busy={busy} browserPreview={browserPreview}
            onOpenCity={onOpenCity} onPreview={onPreviewCityArchive} onCommit={onCommitCityArchive} onCancelPreview={onCancelCityArchivePreview} onRestore={onRestoreCityArchive} />
        </details>}
      </section>
      <CatalogDetails entry={selected} request={request} cities={cities} layouts={layouts} storyProjects={storyCatalog.stories} browserPreview={browserPreview}
        actionLabel={selected ? actionLabel(selected) : ""} busy={busy} detailRef={detailRef}
        onOpen={() => { if (selected) open(selected); }}
        onConfigureGame={onConfigureGame}
        onOpenGamePreview={onOpenGamePreview}
        onRefresh={selected?.kind === "story" ? storyCatalog.retry : onRefreshProjects} />
    </div>
  </div>;
}
