import { useEffect, useState } from "react";
import type { CityRow } from "../../contracts/creatorStudio";
import { archiveDependencyCounts, canCommitArchive, type ArchivedCity, type CityArchivePreview } from "../../contracts/cityLifecycle";

const shortId = (value: unknown) => typeof value === "string" && value.length > 16 ? `${value.slice(0, 16)}…` : typeof value === "string" ? value : "未知";
const ids = (items: readonly Record<string, unknown>[], keys: string[]) => items.slice(0, 4).map(item => {
  const key = keys.find(candidate => typeof item[candidate] === "string");
  return key ? shortId(item[key]) : "未知";
}).join(" · ");

export function CityArchivePanel(props: Readonly<{
  cities: readonly CityRow[];
  archivedCities: readonly ArchivedCity[];
  archivesLoading: boolean;
  archivesError: string;
  preview: CityArchivePreview | null;
  busy: boolean;
  browserPreview: boolean;
  onOpenCity: (cityId: string, revision: number) => void;
  onPreview: (city: CityRow) => void;
  onCommit: () => void;
  onCancelPreview: () => void;
  onRestore: (cityId: string) => void;
}>) {
  const { cities, archivedCities, archivesLoading, archivesError, preview, busy, browserPreview, onOpenCity, onPreview, onCommit, onCancelPreview, onRestore } = props;
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [preview?.dependencyDigest]);
  return <section className="city-archive-panel" aria-label="City 归档与恢复">
    <div className="section-title">City 归档与恢复</div>
    <p className="muted">归档只从正常列表隐藏，不删除作品、安装关系、历史 Release/Candidate、Revision 或世界包。活跃 Run 会阻止归档。</p>
    <div className="creator-project-list">{cities.map(city => <div className="city-list-row" key={city.cityId}>
      <button className="project-row" disabled={busy} onClick={() => onOpenCity(city.cityId, city.revision)}><strong>{city.name}</strong><span>City Instance · revision {city.revision} · 只读预览</span></button>
      <button className="secondary" disabled={busy || browserPreview} onClick={() => onPreview(city)}>归档…</button>
    </div>)}</div>
    {preview && <div className="archive-preview" role="group" aria-label="归档预检">
      <strong>归档预检：{preview.cityId}</strong>
      <p>Installation {preview.installations.length} · Creator Project {preview.projects.length} · Release {preview.releases.length} · Candidate {preview.candidates.length} · 活跃 Run {preview.activeRuns.length}</p>
      <p className="muted">这些依赖仅展示并原样保留，不会级联删除。{preview.worldPackage ? `世界包 ${String(preview.worldPackage.packageId ?? "未知")}@${String(preview.worldPackage.version ?? "未知")} 也保留。` : "没有绑定世界包。"}</p>
      {preview.installations.length > 0 && <code>安装：{ids(preview.installations, ["installationId", "gameId"])}</code>}
      {preview.projects.length > 0 && <code>项目：{ids(preview.projects, ["projectId"])}</code>}
      {preview.releases.length > 0 && <code>Release：{ids(preview.releases, ["releaseId"])}</code>}
      {preview.candidates.length > 0 && <code>Candidate：{ids(preview.candidates, ["candidateId"])}</code>}
      {preview.activeRuns.length > 0 && <p className="library-error" role="alert">存在活跃 Run（{ids(preview.activeRuns, ["runId"])}），当前不能归档。</p>}
      <label className="install-update-confirmation"><input type="checkbox" checked={confirmed} disabled={!preview.canArchive || busy} onChange={event => setConfirmed(event.target.checked)} /><span>我已核对以上真实依赖，确认只归档此 City，不删除任何作品或历史记录。</span></label>
      <div className="actions"><button disabled={!canCommitArchive(preview, confirmed) || busy || browserPreview} onClick={onCommit}>确认归档</button><button className="secondary" disabled={busy} onClick={onCancelPreview}>取消</button></div>
    </div>}
    <div className="archive-list"><div className="section-title">已归档 City</div>
      {archivesLoading ? <p className="muted">正在读取已归档 City…</p> : archivesError ? <p className="library-error" role="alert">归档列表不可用（{archivesError}）。</p> : archivedCities.length === 0 ? <p className="muted">没有已归档 City。</p> : archivedCities.map(city => {
        const counts = archiveDependencyCounts(city.dependencies);
        return <div className="city-list-row" key={city.cityId}><div className="project-row"><strong>{city.name}</strong><span>归档于 {new Date(city.archivedAtMs).toLocaleString("zh-CN")} · 安装 {counts.installations} · 项目 {counts.projects} · Release {counts.releases} · Candidate {counts.candidates}</span></div><button className="secondary" disabled={busy || browserPreview} onClick={() => onRestore(city.cityId)}>恢复</button></div>;
      })}
    </div>
  </section>;
}
