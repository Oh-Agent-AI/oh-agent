import { layoutSelectionKey, type CityRow, type LayoutRow } from "../../contracts/creatorStudio";
import { codeTemplateCatalog, declarativeTemplateCatalog, templateRuntimeLabels } from "./projectCatalogModel";

export function GameStartForm({ cities, layouts, template, worldRevision, busy, submitLabel, onTemplateChange, onLayoutChange, onSubmit, codeGameCreating, activeCodeTemplateId, onCreateCodeTemplate }: Readonly<{
  cities: readonly CityRow[];
  layouts: readonly LayoutRow[];
  template: string;
  worldRevision: string;
  busy: boolean;
  submitLabel: string;
  onTemplateChange: (template: string) => void;
  onLayoutChange: (layout: string) => void;
  onSubmit: () => void;
  codeGameCreating: boolean;
  activeCodeTemplateId: string | null;
  onCreateCodeTemplate: (templateId: string) => void;
}>) {
  const hasLayout = layouts.some(layout => layoutSelectionKey(layout) === worldRevision);
  return <form className="game-start-form" onSubmit={event => {
    event.preventDefault();
    if (!busy && hasLayout) onSubmit();
  }}>
    <label>玩法模板<select value={template} disabled={busy} onChange={event => onTemplateChange(event.target.value)}>
      {declarativeTemplateCatalog.filter(option => option.templateId !== "flight-checkpoint").map(option => <option key={option.templateId} value={option.templateId}>{option.name}</option>)}
    </select></label>
    <label>City 布局<select value={hasLayout ? worldRevision : ""} disabled={busy || layouts.length === 0} onChange={event => onLayoutChange(event.target.value)}>
      {!hasLayout && <option value="" disabled>{layouts.length === 0 ? "暂无 City 布局" : "选择布局"}</option>}
      {layouts.map(layout => {
        const city = cities.find(row => row.cityId === layout.cityId);
        const name = city?.name ?? (layout.cityId ? layout.layoutId : "内置 City");
        return <option key={layoutSelectionKey(layout)} value={layoutSelectionKey(layout)}>
          {name}{layout.cityRevision !== undefined ? ` · 修订 ${layout.cityRevision}` : ""} · {layout.anchorCount} 个锚点
        </option>;
      })}
    </select></label>
    <button className="catalog-primary" type="submit" disabled={busy || !hasLayout}>{submitLabel}</button>
    {layouts.length === 0 && <p className="muted">先打开 City 生成道路布局，再回到 Studio。</p>}
    {codeTemplateCatalog.length > 0 && <section className="game-start-code-templates" aria-label="Code Game 模板">
      <h4>Code Game 模板</h4>
      <ul>{codeTemplateCatalog.map(entry => <li key={entry.templateId}>
        <div className="game-start-code-template-title">
          <strong>{entry.name}</strong>
          <span className="catalog-runtime-badge" data-runtime={entry.runtime}>{templateRuntimeLabels[entry.runtime]}</span>
        </div>
        {entry.description && <p>{entry.description}</p>}
        <small>{[entry.genre, ...entry.tags].filter(Boolean).join(" · ")}</small>
        <small>兼容能力：{entry.requiredCapabilities.join(" / ")}</small>
        <div className="actions">
          <button className="catalog-primary" type="button" disabled={busy}
            onClick={() => onCreateCodeTemplate(entry.templateId)}>
            {activeCodeTemplateId === entry.templateId ? "已创建（当前工作区）" : "以此创建"}
          </button>
        </div>
        <small>创建后 Agent 任务链路切换到该工作区；也可让 Agent 调用 {entry.createTool}（template=&quot;{entry.templateId}&quot;）。</small>
      </li>)}</ul>
    </section>}
  </form>;
}
