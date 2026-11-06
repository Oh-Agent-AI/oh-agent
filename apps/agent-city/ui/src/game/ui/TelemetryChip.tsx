import type { ReactNode } from "react";

export function TelemetryChip({ label, value, unit, children, className = "" }: {
  label: string; value?: ReactNode; unit?: string; children?: ReactNode; className?: string;
}) {
  return <div role="group" className={`city-game-chip city-game-telemetry ${className}`} aria-label={`${label}${value == null ? "" : `: ${value}${unit ? ` ${unit}` : ""}`}`}>
    {children ?? <><span>{label}</span><strong>{value}</strong>{unit && <small>{unit}</small>}</>}
  </div>;
}
