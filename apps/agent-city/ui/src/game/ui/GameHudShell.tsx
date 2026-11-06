import type { ReactNode } from "react";

/** Shared canvas-relative overlay frame. Vehicle content remains vehicle-owned. */
export function GameHudShell({ title, status, telemetry, sound, help, panel, diagnostic, className = "" }: {
  title: ReactNode; status?: ReactNode; telemetry?: ReactNode; sound?: ReactNode; help?: ReactNode;
  panel?: ReactNode; diagnostic?: ReactNode; className?: string;
}) {
  return <div className={`city-game-hud ${className}`}>
    <div className="city-game-topleft">{title}{status}</div>
    {(telemetry || sound) && <div className="city-game-topright">{telemetry}{sound}</div>}
    {help}
    {diagnostic}
    {panel}
  </div>;
}
