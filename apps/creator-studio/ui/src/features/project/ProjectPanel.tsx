import type { Dispatch, SetStateAction } from "react";
import type { CityInstanceV1 } from "@oh-agent/city-sdk";
import { formatWorldPackageInspection, type WorldPackageInspection } from "../../contentPackageInspect";
import { formatInstalledPackage, type InstalledContentPackage } from "../../installedContent";
import type { CityRow } from "../../contracts/creatorStudio";
import type { CityDraft } from "../../contracts/cityLifecycle";
import { CityDraftPanel } from "../city/CityDraftPanel";

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
  cityDraft: CityDraft | null;
  onCreateCityDraft: (name: string, seed: number) => void;
  onCommitCityDraft: () => void;
  onCancelCityDraft: () => void;
}>) {
  const {
    cities, draftCityView, citiesLoading, citiesError, citiesCursor, busy, browserPreview, packageInspection, installedPackages,
    confirmUninstall, setConfirmUninstall,
    onOpenCity, onLoadCities, onExportSource, onExportExperience, onInspectWorldPackage, onInstallInspectedPackage,
    onValidateInstalledPackage, onPreviewInstalledPackage, onCreateCityFromInstalledWorld, onUninstallInstalledPackage,
    cityDraft, onCreateCityDraft, onCommitCityDraft, onCancelCityDraft,
  } = props;
  return <section className="new-project">
    <div><div className="section-title">独立城市</div><p className="muted">打开已保存的城市进行只读预览，或导出城市源码；不会切换玩家的当前 City。</p>
      <div className="project-list">{cities.map(city => <button key={city.cityId} className={`project-row ${draftCityView?.cityId === city.cityId ? "selected" : ""}`} disabled={busy || citiesLoading} onClick={() => onOpenCity(city.cityId, city.revision)}><strong>{city.name}</strong><span>版本 {city.revision}{draftCityView?.cityId === city.cityId ? " · 预览中" : ""}</span></button>)}</div>
      {citiesLoading && <p className="muted">正在读取城市…</p>}
      {citiesError && <p className="muted">城市列表读取失败，请重试。</p>}
      {!citiesLoading && !citiesError && cities.length === 0 && <p className="muted">还没有独立城市。</p>}
      <div className="actions"><button className="secondary" disabled={citiesLoading || busy} onClick={() => onLoadCities()}>刷新城市列表</button>{citiesCursor && <button className="secondary" disabled={citiesLoading || busy} onClick={() => onLoadCities(citiesCursor)}>加载更多</button>}</div>
    </div>
    <details className="advanced-editor"><summary>新建城市</summary>
    <CityDraftPanel draft={cityDraft} busy={busy} browserPreview={browserPreview} onCreate={onCreateCityDraft} onCommit={onCommitCityDraft} onCancel={onCancelCityDraft} />
    </details>
    <details className="advanced-editor"><summary>导入、导出与安装</summary>
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
    </details>
  </section>;
}
