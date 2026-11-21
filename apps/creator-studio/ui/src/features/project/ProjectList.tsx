import type { ProjectRow } from "../../contracts/creatorStudio";

const formatDate = (value: number) => new Date(value).toLocaleString("zh-CN");

export function ProjectList(props: Readonly<{
  projects: readonly ProjectRow[];
  loading: boolean;
  error: string;
  busy?: boolean;
  emptyMessage: string;
  onOpenProject: (projectId: string) => void;
  onRefresh: () => void;
}>) {
  const { projects, loading, error, busy = false, emptyMessage, onOpenProject, onRefresh } = props;
  return <div className="creator-project-list" aria-label="可编辑 Creator Project 列表">
    {loading && projects.length === 0 && <p className="muted">正在读取真实 Creator Project…</p>}
    {error && <div className="library-error" role="alert"><span>项目列表不可用（{error}）。</span><button className="secondary" disabled={loading} onClick={onRefresh}>重试</button></div>}
    {!loading && !error && projects.length === 0 && <p className="muted">{emptyMessage}</p>}
    {projects.map(row => <button className="project-row" key={row.projectId} disabled={busy} onClick={() => onOpenProject(row.projectId)}><strong>{row.title}</strong><span>Creator Project · revision {row.revision} · 更新于 {formatDate(row.updatedAtMs)}</span></button>)}
  </div>;
}
