import type { CityRow, ProjectRow } from "../../contracts/creatorStudio";
import { ProjectList } from "./ProjectList";
import { CityArchivePanel } from "../city/CityArchivePanel";
import type { ArchivedCity, CityArchivePreview } from "../../contracts/cityLifecycle";

export function ProjectsPage(props: Readonly<{
  projects: readonly ProjectRow[];
  projectsLoading: boolean;
  projectsError: string;
  cities: readonly CityRow[];
  citiesLoading: boolean;
  citiesError: boolean;
  busy: boolean;
  browserPreview: boolean;
  onOpenProject: (projectId: string) => void;
  onRefreshProjects: () => void;
  onOpenCity: (cityId: string, revision: number) => void;
  onRefreshCities: () => void;
  onCreateProject: () => void;
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
    projects, projectsLoading, projectsError, cities, citiesLoading, citiesError, busy, browserPreview,
    onOpenProject, onRefreshProjects, onOpenCity, onRefreshCities, onCreateProject,
    archivedCities, archivesLoading, archivesError, archivePreview, onPreviewCityArchive, onCommitCityArchive, onCancelCityArchivePreview, onRestoreCityArchive,
  } = props;
  return <div className="projects-page">
    <section aria-labelledby="creator-projects-title">
      <div className="home-section-heading"><div><span className="section-title" id="creator-projects-title">可编辑 Creator Project</span><p className="muted">模板 MiniGame 源项目；Code Build 不会出现在这里。</p></div><button onClick={onCreateProject}>新建 Game 项目</button></div>
      <ProjectList projects={projects} loading={projectsLoading} error={projectsError} busy={busy} emptyMessage="还没有可编辑 Creator Project。" onOpenProject={onOpenProject} onRefresh={onRefreshProjects} />
    </section>
    <section aria-labelledby="city-instances-title">
      <div className="home-section-heading"><div><span className="section-title" id="city-instances-title">独立 City 实例</span><p className="muted">City 是独立世界实例，不是 Creator Project；这里仅打开现有的只读预览。</p></div><button className="secondary" disabled={citiesLoading || busy} onClick={onRefreshCities}>刷新 City</button></div>
      {citiesLoading && cities.length === 0 && <p className="muted">正在读取真实 City 实例…</p>}
      {citiesError && <p className="library-error" role="alert">City 列表读取失败，请重试。</p>}
      {!citiesLoading && !citiesError && cities.length === 0 && <p className="muted">还没有独立 City 实例。</p>}
      <CityArchivePanel cities={cities} archivedCities={archivedCities} archivesLoading={archivesLoading} archivesError={archivesError} preview={archivePreview} busy={busy} browserPreview={browserPreview}
        onOpenCity={onOpenCity} onPreview={onPreviewCityArchive} onCommit={onCommitCityArchive} onCancelPreview={onCancelCityArchivePreview} onRestore={onRestoreCityArchive} />
    </section>
  </div>;
}
