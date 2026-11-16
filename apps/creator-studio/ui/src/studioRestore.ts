const STORAGE_KEY = "creator-studio.last-project";
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Which project the rebuilt Studio should open.
 * A one-shot playtest return wins. The stored id is only an editor restore
 * when that return is absent. This never starts a playtest.
 *
 * Linux keeps the plugin WebView profile, so localStorage survives a rebuild.
 * macOS plugin WebViews are incognito, so this key does not survive a rebuild there.
 */
export function projectIdAfterStudioReload(returnProjectId: string | null | undefined, storedProjectId: string | null | undefined): string | null {
  if (typeof returnProjectId === "string" && PROJECT_ID.test(returnProjectId)) return returnProjectId;
  if (typeof storedProjectId === "string" && PROJECT_ID.test(storedProjectId)) return storedProjectId;
  return null;
}

type KeyValueStore = {
  getItem?(key: string): string | null;
  setItem?(key: string, value: string): void;
  removeItem?(key: string): void;
};

export function readStoredStudioProject(storage: KeyValueStore | null | undefined): string | null {
  try { return projectIdAfterStudioReload(null, storage?.getItem?.(STORAGE_KEY) ?? null); }
  catch { return null; }
}

export function rememberStudioProject(storage: KeyValueStore | null | undefined, projectId: string): void {
  if (!PROJECT_ID.test(projectId)) return;
  try { storage?.setItem?.(STORAGE_KEY, projectId); } catch { /* private or incognito storage */ }
}

export function forgetStudioProject(storage: KeyValueStore | null | undefined): void {
  try { storage?.removeItem?.(STORAGE_KEY); } catch { /* private or incognito storage */ }
}
