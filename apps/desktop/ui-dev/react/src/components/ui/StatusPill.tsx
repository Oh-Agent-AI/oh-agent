import type { ReactNode } from "react";

export type StatusPillTone = "neutral" | "success" | "warning" | "danger";

const toneClasses: Record<StatusPillTone, string> = {
  neutral: "",
  success: "status-pill-success",
  warning: "status-pill-warning",
  danger: "status-pill-danger",
};

/** Small, text-labelled status primitive; color is only a supporting signal. */
export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: StatusPillTone }) {
  return <span className={`status-pill inline-flex items-center ${toneClasses[tone]}`}>
    <span aria-hidden="true" className="status-dot" />
    {children}
  </span>;
}
