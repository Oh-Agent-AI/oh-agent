import { useState, type ReactNode } from "react";
import { gameText, type GameLocale } from "../gameCopy";

export type GameControlRow = Readonly<{ keys: string; description: string }>;
export function GameControlsHelp({ locale, rows, className = "", onOpenChange, expandedContent }: {
  locale: GameLocale; rows: readonly GameControlRow[]; className?: string;
  onOpenChange?: (open: boolean) => void; expandedContent?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const t = (text: string) => gameText(text, locale);
  return <details className={`city-game-chip city-game-keys ${className}`} open={open}
    onToggle={(event) => { const next = (event.currentTarget as HTMLDetailsElement).open; setOpen(next); onOpenChange?.(next); }}>
    <summary aria-label={t("按键提示")}>{t("按键提示")} · {t(open ? "收起" : "展开")}</summary>
    <dl>{rows.map((row) => <div key={`${row.keys}:${row.description}`}><dt>{t(row.keys)}</dt><dd>{t(row.description)}</dd></div>)}</dl>
    {expandedContent}
  </details>;
}
