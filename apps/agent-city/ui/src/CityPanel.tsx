import { useEffect, useId, useRef, type ReactNode } from "react";
import { cityText, cityView, useCityLanguage } from "./i18n";

/**
 * 城市里所有「点建筑弹出」的面板共用这一个外壳（会话楼、市政厅、城区地标、配套说明、数据窗口）。
 * 曾经各写各的：数据窗口有大号关闭键、44px 按钮和自身接焦点后的浏览器蓝框，其余面板是浮动的小 ×、
 * 普通 <p> 当类别——同一处位置弹出两种长相（用户截图反馈）。头部结构、关闭键、按钮尺寸、
 * 焦点与 Esc 行为只在这里定义一次，面板只管内容。
 *
 * cityView 遇到函数组件就停（不往里翻译），所以外壳自己对头部与 children 再过一遍：
 * 调用方照旧写中文原文，英文界面不会因为套了这层组件而漏译。
 *
 * 右侧同一时刻只放一个面板：下钻（城区地标 → 本区诊断中心、建筑说明 → 某栋楼）是原地替换，
 * 不是叠一层新弹窗。上一层由 `back` 给出「‹ 返回 …」，× 永远是退出回到城市；Esc 先退一层。
 */
type Props = {
  /** 类别小字（「城区公共服务」「公共服务 · 数据窗口」）。 */
  eyebrow: ReactNode;
  /** 标题上方的从属说明（如所属执行环境），可选。 */
  context?: ReactNode;
  title: ReactNode;
  closeLabel: string;
  onClose(): void;
  /** 有上一层时给出：头部显示「‹ 返回 …」，Esc 也先回上一层。 */
  back?: { label: ReactNode; onBack(): void };
  /** 打开时把焦点移进面板（读屏/键盘直接进入）；容器自身不画焦点框。 */
  focusOnOpen?: boolean;
  busy?: boolean;
  className?: string;
  children?: ReactNode;
};

export function CityPanel({ eyebrow, context, title, closeLabel, onClose, back, focusOnOpen = false, busy, className, children }: Props) {
  const locale = useCityLanguage();
  const panel = useRef<HTMLElement>(null);
  const heading = useId();
  useEffect(() => {
    if (!focusOnOpen) return;
    const previous = document.activeElement;
    panel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [focusOnOpen]);
  return <aside className={className ? `city-detail-panel ${className}` : "city-detail-panel"} ref={panel} tabIndex={-1}
    aria-labelledby={heading} aria-busy={busy}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); (back?.onBack ?? onClose)(); } }}>
    {back && <button className="city-panel-back" onClick={back.onBack}>‹ {cityView(back.label, locale)}</button>}
    <header className="city-panel-header">
      <div className="city-panel-heading">
        <p className="city-panel-eyebrow">{cityView(eyebrow, locale)}</p>
        {context && <p className="city-panel-context">{cityView(context, locale)}</p>}
        <h2 id={heading}>{cityView(title, locale)}</h2>
      </div>
      <button className="city-close" aria-label={cityText(closeLabel, locale)} onClick={onClose}>×</button>
    </header>
    {cityView(children, locale)}
  </aside>;
}
