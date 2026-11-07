import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Classic HUD action card. The rules adapter supplies state and interaction handlers. */
export function MechaActionCard({ label, icon, status, className = "", ...button }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: ReactNode;
  icon: ReactNode;
  status: ReactNode;
}) {
  return <button {...button} className={`mecha-action-card${className ? ` ${className}` : ""}`}>
    <span>{label}</span>{icon}<small>{status}</small>
  </button>;
}
