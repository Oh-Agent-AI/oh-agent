import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep page-owned state and handlers beside the page while rendering controls in the macOS toolbar. */
export function ToolbarActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 700px)").matches);

  useEffect(() => {
    setTarget(document.getElementById("desktop-toolbar-actions"));
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  if (compact) return <div className="page-action-bar">{children}</div>;
  return target ? createPortal(children, target) : null;
}
