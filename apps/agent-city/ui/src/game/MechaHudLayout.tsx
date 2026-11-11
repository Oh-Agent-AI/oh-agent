import { createContext, useContext, type ReactNode } from "react";
import type { MechaHudActions, MechaHudModel } from "./mecha/hud/model";

const MechaHudActionsContext = createContext<MechaHudActions | null>(null);

export function useMechaHudActions(): MechaHudActions | null {
  return useContext(MechaHudActionsContext);
}

/** Shared presentation boundary for classic and sequential rulesets. */
export function MechaHud({
  className,
  model,
  actions,
  mapFocus,
  remoteActive,
  dataMechaV15,
  children,
}: {
  className: string;
  model: MechaHudModel;
  actions: MechaHudActions;
  mapFocus?: boolean;
  remoteActive?: boolean;
  dataMechaV15?: boolean;
  children: ReactNode;
}) {
  return <MechaHudActionsContext.Provider value={actions}>
    <section
      className={className}
      data-phase={model.sourcePhase}
      data-hud-phase={model.phase}
      data-hud-mode={model.mode}
      data-round={model.round}
      data-map-focus={mapFocus ? "true" : undefined}
      data-remote-active={remoteActive ? "true" : undefined}
      role="dialog"
      aria-label={model.label}
      data-mecha-v15={dataMechaV15 ? "" : undefined}
    >{children}</section>
  </MechaHudActionsContext.Provider>;
}
