/** Close the topmost HUD disclosure and return focus to its summary control. */
export function closeOpenGameDisclosure(): boolean {
  const disclosure = [...document.querySelectorAll<HTMLDetailsElement>(".city-game-hud details[open]")].at(-1);
  if (!disclosure) return false;
  disclosure.open = false;
  disclosure.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
  return true;
}
