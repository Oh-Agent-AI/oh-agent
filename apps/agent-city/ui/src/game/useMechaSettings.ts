import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MechaSettingsPanel = "battlefield" | "remote" | null;

/** Shared classic popover interaction, including focus return and outside dismissal. */
export function useMechaSettings(onOpen: () => void) {
  const [settingsPanel, setSettingsPanel] = useState<MechaSettingsPanel>(null);
  const settingsTrigger = useRef<HTMLButtonElement | null>(null);
  const closeSettings = () => { setSettingsPanel(null); settingsTrigger.current?.focus(); };
  const toggleSettings = (next: Exclude<MechaSettingsPanel, null>, trigger: HTMLButtonElement) => {
    trigger.closest(".mecha-battle-bar")?.querySelector<HTMLDetailsElement>(".mecha-battle-menu")?.removeAttribute("open");
    settingsTrigger.current = trigger;
    onOpen();
    setSettingsPanel(current => current === next ? null : next);
  };
  useLayoutEffect(() => {
    if (settingsPanel) document.getElementById(`mecha-${settingsPanel}-settings`)?.querySelector<HTMLButtonElement>(".mecha-settings-close")?.focus();
  }, [settingsPanel]);
  useEffect(() => {
    if (!settingsPanel) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(".mecha-settings-popover, [data-mecha-settings-trigger], [data-replay-unsaved-guard]")) return;
      setSettingsPanel(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [settingsPanel]);
  return { settingsPanel, setSettingsPanel, closeSettings, toggleSettings };
}
