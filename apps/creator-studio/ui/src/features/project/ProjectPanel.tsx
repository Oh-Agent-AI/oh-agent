import type { Dispatch, SetStateAction } from "react";
import type { CityInstanceV1 } from "@oh-agent/city-sdk";
import { formatWorldPackageInspection, type WorldPackageInspection } from "../../contentPackageInspect";
import { formatInstalledPackage, type InstalledContentPackage } from "../../installedContent";
import { layoutSelectionKey, type CityRow, type LayoutRow, type Project, type ProjectRow } from "../../contracts/creatorStudio";

export function ProjectPanel(props: Readonly<{
  cities: readonly CityRow[];
  draftCityView: CityInstanceV1 | null;
  citiesLoading: boolean;
  citiesError: boolean;
  citiesCursor: string | null;
  busy: boolean;
  browserPreview: boolean;
  packageInspection: WorldPackageInspection | null;
  installedPackages: readonly InstalledContentPackage[];
  confirmUninstall: string | null;
  projects: readonly ProjectRow[];
  project: Project | null;
  switchConfirm: string | null;
  layouts: readonly LayoutRow[];
  template: string;
  worldRevision: string;
  setTemplate: Dispatch<SetStateAction<string>>;
  setWorldRevision: Dispatch<SetStateAction<string>>;
  setConfirmUninstall: Dispatch<SetStateAction<string | null>>;
  onOpenCity: (cityId: string, revision: number) => void;
  onLoadCities: (cursor?: string) => void;
  onExportSource: () => void;
  onExportExperience: () => void;
  onInspectWorldPackage: () => void;
  onInstallInspectedPackage: () => void;
  onValidateInstalledPackage: (item: InstalledContentPackage) => void;
  onPreviewInstalledPackage: (item: InstalledContentPackage) => void;
  onCreateCityFromInstalledWorld: (item: InstalledContentPackage) => void;
  onUninstallInstalledPackage: (item: InstalledContentPackage) => void;
  onSelectProject: (row: ProjectRow) => void;
  onCreateProject: () => void;
}>) {
  const {
    cities, draftCityView, citiesLoading, citiesError, citiesCursor, busy, browserPreview, packageInspection, installedPackages,
    confirmUninstall, projects, project, switchConfirm, layouts, template, worldRevision, setTemplate, setWorldRevision, setConfirmUninstall,
    onOpenCity, onLoadCities, onExportSource, onExportExperience, onInspectWorldPackage, onInstallInspectedPackage,
    onValidateInstalledPackage, onPreviewInstalledPackage, onCreateCityFromInstalledWorld, onUninstallInstalledPackage, onSelectProject, onCreateProject,
  } = props;
  return <section className="new-project">
    <div><div className="section-title">独立城市</div><p className="muted">打开已保存的城市进行只读预览，或导出城市源码；不会切换玩家的当前 City。</p>
      <div className="project-list">{cities.map(city => <button key={city.cityId} className={`project-row ${draftCityView?.cityId === city.cityId ? "selected" : ""}`} disabled={busy || citiesLoading} onClick={() => onOpenCity(city.cityId, city.revision)}><strong>{city.name}</strong><span>版本 {city.revision}{draftCityView?.cityId === city.cityId ? " · 预览中" : ""}</span></button>)}</div>
      {citiesLoading && <p className="muted">正在读取城市…</p>}
      {citiesError && <p className="muted">城市列表读取失败，请重试。</p>}
      {!citiesLoading && !citiesError && cities.length === 0 && <p className="muted">还没有独立城市。</p>}
      <div className="actions"><button className="secondary" disabled={citiesLoading || busy} onClick={() => onLoadCities()}>刷新城市列表</button>{citiesCursor && <button className="secondary" disabled={citiesLoading || busy} onClick={() => onLoadCities(citiesCursor)}>加载更多</button>}</div>
    </div>
    <div><div className="section-title">导出源码项目</div><p className="muted">导出已保存的独立城市和小游戏；未绑定的游戏需配置场地后才能试玩。导出不包含用户会话或试玩结果。</p>
      <button className="secondary" onClick={onExportSource}>导出源码目录…</button></div>
    <div><div className="section-title">导出体验包</div><p className="muted">把**已发布**版本打成自包含产物（冻结快照 + 布局几何 + 资产）；干净客户端装上即可启动，不依赖本机 Creator 库。</p>
      <button className="secondary" onClick={onExportExperience}>导出体验包目录…</button></div>
    <div><div className="section-title">世界内容包预检</div><p className="muted">通过桌面原生选择器打开 unsigned 的 v2 世界包，核对清单、文件集合与摘要；校验后可显式安装到本机内容库。文件路径和字节不会传入 Agent/MCP。</p>
    <button className="secondary" disabled={busy || browserPreview} onClick={onInspectWorldPackage}>选择并预检世界包…</button>
    {browserPreview && <p className="muted">浏览器预览没有原生文件选择器，请在桌面应用中使用。</p>}
    {packageInspection && <code>{formatWorldPackageInspection(packageInspection)}</code>}
    {packageInspection && <div className="actions"><button disabled={busy} onClick={onInstallInspectedPackage}>安装到本机内容库</button><span className="muted">仅本机存储，尚不可运行</span></div>}
    {installedPackages.length > 0 && <div><div className="section-title">已安装内容包</div>{installedPackages.map(item => <div key={`${item.packageId}:${item.version}`} className="actions"><code>{formatInstalledPackage(item)}</code><button className="secondary" disabled={busy} onClick={() => onValidateInstalledPackage(item)}>检查内容</button><button className="secondary" disabled={busy} onClick={() => onPreviewInstalledPackage(item)}>只读预览</button><button disabled={busy} onClick={() => onCreateCityFromInstalledWorld(item)}>创建独立 City</button><button className="secondary" disabled={busy} onClick={() => { const key = `${item.packageId}:${item.version}`; if (confirmUninstall === key) onUninstallInstalledPackage(item); else setConfirmUninstall(key); }}>{confirmUninstall === `${item.packageId}:${item.version}` ? "确认卸载" : "卸载"}</button></div>)}</div>}</div>
    <div className="section-title">打开项目</div>
    <div className="project-list">{projects.map(row => <button key={row.projectId} className={`project-row ${project?.projectId === row.projectId ? "selected" : ""}`} disabled={busy} onClick={() => onSelectProject(row)}><strong>{row.title}</strong><span>版本 {row.revision}{project?.projectId === row.projectId ? " · 当前项目" : switchConfirm === row.projectId ? " · 再次点击以丢弃草稿" : ""}</span></button>)}</div>
    <div><div className="section-title">创建模板 Game 项目</div><p className="muted">选择玩法和 City 布局，创建独立的本地 Creator Project 草稿。</p></div>
    <label>新建模板<select value={template} disabled={busy} onChange={event => setTemplate(event.target.value)}><option value="checkpoint-race">驾驶检查点竞速</option><option value="collect-one">驾驶区域收集</option><option value="ornithopter-flight">扑翼飞行检查点</option></select></label>
    <label>绑定 City 世界<select value={worldRevision} disabled={busy || layouts.length === 0} onChange={event => setWorldRevision(event.target.value)}>{layouts.map(layout => <option key={layoutSelectionKey(layout)} value={layoutSelectionKey(layout)}>{layout.cityId ? `${layout.cityId} · ` : "Miami · "}{layout.layoutId} · seed {layout.seed} · {layout.anchorCount} 个锚点</option>)}</select></label>
    <button disabled={busy || !worldRevision} onClick={onCreateProject}>{switchConfirm === "create" ? "确认丢弃草稿并新建" : "新建 Game 项目"}</button>
    {layouts.length === 0 && <p className="muted">尚无 City 布局快照。先打开 City 生成道路地图，再回到 Studio。</p>}
  </section>;
}
