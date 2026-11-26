import { CREATOR_TEMPLATES_V1 } from "@oh-agent/city-sdk";
import { layoutSelectionKey, type CityRow, type LayoutRow } from "../../contracts/creatorStudio";

export function GameStartForm({ cities, layouts, template, worldRevision, busy, submitLabel, onTemplateChange, onLayoutChange, onSubmit }: Readonly<{
  cities: readonly CityRow[];
  layouts: readonly LayoutRow[];
  template: string;
  worldRevision: string;
  busy: boolean;
  submitLabel: string;
  onTemplateChange: (template: string) => void;
  onLayoutChange: (layout: string) => void;
  onSubmit: () => void;
}>) {
  const hasLayout = layouts.some(layout => layoutSelectionKey(layout) === worldRevision);
  return <form className="game-start-form" onSubmit={event => {
    event.preventDefault();
    if (!busy && hasLayout) onSubmit();
  }}>
    <label>玩法模板<select value={template} disabled={busy} onChange={event => onTemplateChange(event.target.value)}>
      {CREATOR_TEMPLATES_V1.filter(option => option.id !== "flight-checkpoint").map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
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
  </form>;
}
