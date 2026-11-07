import type { ReactNode } from "react";

/** Shared presentation frame for classic and sequential mecha rulesets. */
export function MechaHudLayout({
  className,
  ariaLabel,
  phase,
  mapFocus,
  remoteActive,
  dataMechaV15,
  children,
}: {
  className: string;
  ariaLabel: string;
  phase?: string;
  mapFocus?: boolean;
  remoteActive?: boolean;
  dataMechaV15?: boolean;
  children: ReactNode;
}) {
  return <section
    className={className}
    data-phase={phase}
    data-map-focus={mapFocus ? "true" : undefined}
    data-remote-active={remoteActive ? "true" : undefined}
    role="dialog"
    aria-label={ariaLabel}
    data-mecha-v15={dataMechaV15 ? "" : undefined}
  >{children}</section>;
}
