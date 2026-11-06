/** Local preference only. A new installation defaults to automatic saving. */
export const REPLAY_AUTO_SAVE_KEY = "agent-city:mecha-replay-auto-save:v1";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function readReplayAutoSaveStrict(storage: () => PreferenceStorage): boolean {
  const value = storage().getItem(REPLAY_AUTO_SAVE_KEY);
  return value === null || value === "enabled";
}

export function readReplayAutoSave(storage: () => PreferenceStorage): boolean {
  try { return readReplayAutoSaveStrict(storage); }
  catch { return false; }
}

export function writeReplayAutoSave(storage: () => PreferenceStorage, enabled: boolean): void {
  const target = storage();
  const value = enabled ? "enabled" : "disabled";
  target.setItem(REPLAY_AUTO_SAVE_KEY, value);
  if (target.getItem(REPLAY_AUTO_SAVE_KEY) !== value) throw new Error("Unable to persist replay preference");
}
